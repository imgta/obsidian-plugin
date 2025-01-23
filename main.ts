import { App, Editor, MarkdownView, MarkdownFileInfo, Modal, Menu, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { promises as fs, configureSingle } from '@zenfs/core'
import { IndexedDB } from '@zenfs/dom'

interface GitConfig {
	githubUser: string
	repositoryPath: string
	vaultFolder: string
	personalAccessToken: string
}

const DEFAULT_SETTINGS: GitConfig = {
	githubUser: '',
	repositoryPath: '',
	vaultFolder: '',
	personalAccessToken: '',
}

export default class WorldEditPlugin extends Plugin {
	settings: GitConfig = DEFAULT_SETTINGS;

	async initZenDB() {
		await configureSingle({
			backend: IndexedDB,
			storeName: 'worldedit-db',
		})
	}

	private getRepoPath() {
		const { githubUser, repositoryPath, vaultFolder, personalAccessToken } = this.settings;
		if (!githubUser || !repositoryPath) {
			return { error: 'Error: GitHub username and repositoryPath must be configured in the settings.' }
		}

		let url = `https://${personalAccessToken}@github.com/${githubUser}/${repositoryPath}`;
		if (vaultFolder) { url += `/${vaultFolder}` }

		const dir = `/${repositoryPath}`
		return { url, dir }
	}

	private async gitPull() {
		const status = new Notice('Pulling from GitHub...')
		await this.initZenDB()

		const { dir, url, error } = this.getRepoPath()
		if (!dir && !url) { return status.setMessage(error as string) }

		const isCloned = await fs
			.stat(`${dir}/.git`)
			.then(() => true)
			.catch(() => false);

		const gitOptions = { fs, dir, url }

		if (!isCloned) { // clone
			await git.addRemote({
				...gitOptions,
				remote: 'origin',
			})
			await git.clone({
				...gitOptions,
				http,
				ref: 'main',
				singleBranch: true,
				depth: 1 // if you only need the latest
			});
		} else { // fetch + merge
			await git.fetch({ ...gitOptions, http }); // fetch updates

			const { githubUser } = this.settings;
			await git.merge({
				...gitOptions,
				theirs: "remotes/origin/main",
				author: { name: githubUser },
			});
		}

		const files = await fs.readdir(dir);
		const filteredFiles = files.filter(file => !file.startsWith('.git'));
		new VaultListModal(this.app, filteredFiles).open();

		// for (const file of files) {
		// 	const content = await fs.readFile(`${dir}/${file}`, 'utf8')
		// 	console.log(content)
		// }

		new Notice('Pull complete!')
	}

	private async gitPush() {
		const status = new Notice('Pushing to GitHub...')
		await this.initZenDB()

		const { dir, url, error } = this.getRepoPath()
		if (!dir && !url) { return status.setMessage(error as string) }

		const gitOptions = { fs, dir }
		const allFiles = await fs.readdir(dir);

		// stage changes (add + commit)
		for (const file of allFiles) {
			// simple example - skip .git
			if (file === ".git") continue;
			await git.add({
				...gitOptions,
				filepath: file
			});
		}

		const { githubUser, personalAccessToken } = this.settings;
		const sha = await git.commit({ // commit changes
			...gitOptions,
			message: "Update notes from Obsidian",
			author: {
				name: githubUser,
				email: `${githubUser}@users.noreply.github.com`
			}
		});
		console.log("Committed with SHA:", sha);

		await git.push({ // push changes
			...gitOptions,
			http,
			ref: 'main',
			remote: 'origin',
			onAuth: () => ({ username: personalAccessToken }),
		});

		new Notice('Push complete!')
	}

	async onload() {
		console.log('Loading Git configurations...')
		await this.loadSettings();

		// adds a settings tab for the plugin
		this.addSettingTab(new GitConfigTab(this.app, this))

		// side ribbon button
		this.addRibbonIcon('orbit', 'WorldEdit', (e: MouseEvent) => {
			const menu = new Menu()

			const options = [
				{ title: 'Settings', icon: 'settings', action: () => new SettingsModal(this.app, this).open() },
				{ title: 'Pull from GitHub', icon: 'arrow-down-to-line', action: () => this.gitPull() },
				{ title: 'Push to GitHub', icon: 'arrow-up-from-line', action: () => this.gitPush() },
			];

			options.forEach(option => {
				menu.addItem(item => item
					.setTitle(option.title)
					.setIcon(option.icon)
					.onClick(option.action)
				)
			});
			menu.showAtMouseEvent(e) // displays selectmenu at click position
		}).addClass('ribbon')

		this.addCommand({
			id: 'view-pulled-files',
			name: 'View Pulled Files',
			callback: async () => {
				const { dir, error } = this.getRepoPath();
				if (!dir) { return new Notice(error as string); }

				try {
					const allFiles = await fs.readdir(dir);
					const filteredFiles = allFiles.filter(
						(file) => !file.startsWith('.git')
					);

					new VaultListModal(this.app, filteredFiles).open();
				} catch (err) {
					console.error('Error reading files:', err);
					new Notice('Error reading repository files.');
				}
			},
		});

	}

	async onunload() { console.log("Unloading WorldEdit plugin..."); }

	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }
}

class GitConfigTab extends PluginSettingTab {
	plugin: WorldEditPlugin;
	constructor(app: App, plugin: WorldEditPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		buildSettings(
			this.containerEl,
			this.plugin.settings,
			async () => { await this.plugin.saveSettings(); }
		)
	}
}

class VaultListModal extends Modal {
	files: string[];
	selectedFiles: Set<string>;

	constructor(app: App, files: string[]) {
		super(app);
		this.files = files;
		this.selectedFiles = new Set();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Select Vaults' });

		if (this.files.length === 0) {
			contentEl.createEl('p', { text: 'No vaults found.' });
		} else {
			const form = contentEl.createEl('form'); // form for better structure

			this.files.forEach(file => {
				const checkbox = form.createEl('input', { type: 'checkbox' });
				checkbox.id = file
				checkbox.onchange = () => this.toggleFileSelection(file, checkbox.checked);

				const label = form.createEl('label', { text: file, attr: { for: file } });

				const wrapper = form.createDiv({ cls: 'file-item' });
				wrapper.appendChild(checkbox);
				wrapper.appendChild(label);
			});

			const logButton = contentEl.createEl('button', { text: 'Log Vaults', cls: 'modal-btn' });
			logButton.onclick = (e: MouseEvent) => {
				e.preventDefault(); // prevent form submission behavior
				this.logSelectedFiles();
			};
		}
	}

	toggleFileSelection(file: string, isSelected: boolean) {
		if (isSelected) {
			this.selectedFiles.add(file);
		} else {
			this.selectedFiles.delete(file);
		}
	}

	logSelectedFiles() {
		console.log('Selected Vaults:', Array.from(this.selectedFiles));
		new Notice('Selected vaults logged to console!');
	}

	onClose() { this.contentEl.empty(); }
}

class SettingsModal extends Modal {
	plugin: WorldEditPlugin
	constructor(app: App, plugin: WorldEditPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		buildSettings(this.contentEl, this.plugin.settings, async () => {
			await this.plugin.saveSettings()
			this.close()
		})
		// cancel button for the modal
		this.contentEl.createEl("button", { text: "Cancel", cls: 'modal-btn' }).onclick = () => this.close();
	}

	onClose() { this.contentEl.empty(); }
}


function buildSettings(containerEl: HTMLElement, settings: GitConfig, saveSettings: () => Promise<void>) {
	containerEl.empty();
	containerEl.createEl("h2", { text: "WorldEdit Settings" });

	const reactivePathEl = containerEl.createDiv({ cls: "github-path" });
	const updateGithubPath = () => {
		const { githubUser, repositoryPath, vaultFolder } = settings;
		let githubPath = `github.com/`;
		if (githubUser) githubPath += githubUser;
		if (repositoryPath) githubPath += `/${repositoryPath}`;
		if (vaultFolder) githubPath += `/${vaultFolder}`;
		reactivePathEl.textContent = githubPath;
	};
	updateGithubPath();

	new Setting(containerEl)
		.setName("GitHub Username")
		.setDesc("Enter your GitHub username.")
		.addText(text => text
			.setPlaceholder("imgta")
			.setValue(settings.githubUser)
			.onChange(value => { settings.githubUser = value; updateGithubPath(); })
		);

	new Setting(containerEl)
		.setName("Repository")
		.setDesc("Enter your repository name.")
		.addText(text => text
			.setPlaceholder("my-repo")
			.setValue(settings.repositoryPath)
			.onChange(value => { settings.repositoryPath = value; updateGithubPath(); })
		);

	const tokenDesc = document.createElement('div')
	tokenDesc.innerHTML = `<p>Generate one <a href='https://github.com/settings/personal-access-tokens/new' target='_blank'>here</a>.</p>`
	tokenDesc.setAttribute('class', 'setting-item-description')

	new Setting(containerEl)
		.setName("Personal Access Token")
		.setDesc('Enter your GitHub Personal Access Token.')
		.addText(text => text
			.setPlaceholder("github_pat_...")
			.setValue(settings.personalAccessToken)
			.onChange(value => { settings.personalAccessToken = value; updateGithubPath(); })
			.inputEl.setAttribute("type", "password")
		)
	containerEl.appendChild(tokenDesc)

	new Setting(containerEl)
		.setName("Vault Folder (optional)")
		.setDesc("Subdirectory for your vault in the repo.")
		.addText(text => text
			.setPlaceholder("vault_1")
			.setValue(settings.vaultFolder)
			.onChange(value => { settings.vaultFolder = value; updateGithubPath(); })
		);

	// save button (optional for modal)
	const saveButton = containerEl.createEl("button", { text: "Save", cls: 'modal-btn' });
	saveButton.onclick = async () => {
		await saveSettings();
		new Notice("Settings saved!");
	};
}
