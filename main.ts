import { App, Events, Modal, Menu, Notice, Plugin, PluginManifest, PluginSettingTab, Setting } from 'obsidian';

const DEFAULT_SETTINGS: WorldEditSettings = {
	auth: {
		id: '',
		email: '',
		refreshToken: '',
		accessToken: '',
		accessExpiry: null,
	},
	sync: {
		rootFolders: [],
		selectedFolder: {
			id: '',
			name: '',
		},
		vaultName: '',
		lastSynced: null,
	}
};

class WorldEditEvents extends Events {
	authUpdate(): void {
		this.trigger('auth-updated');
	}
}

export default class WorldEditPlugin extends Plugin {
	settings: WorldEditSettings = DEFAULT_SETTINGS;
	events: WorldEditEvents;
	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.events = new WorldEditEvents();
	}

	async saveSettings() { await this.saveData(this.settings); }
	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});

		if (!data) { await this.saveSettings(); } // save only if data exists (creates new data.json)
	}

	async onload() {
		// action event listener for URI redirects to `obsidian://`
		this.registerObsidianProtocolHandler('worldedit', async params => {
			this.settings.sync.vaultName = this.app.vault.getName();

			if (params.user) {
				const [id, email] = params.user.split(':');
				this.settings.auth.id = id;
				this.settings.auth.email = email;

				const res = await fetch('http://localhost:3000/api/vault/google', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ userId: id }),
				});
				const authData = await res.json();

				if (authData) {
					const { accessToken, expiry, refreshToken } = authData;
					this.settings.auth.accessToken = accessToken;
					this.settings.auth.refreshToken = refreshToken;
					this.settings.auth.accessExpiry = expiry;

					const res = await fetch('http://localhost:3000/api/vault/google/drive', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ refreshToken }),
					});

					const { files: rootFolders } = await res.json();
					if (rootFolders.length) {
						this.settings.sync.rootFolders = rootFolders;
					}
				}

				await this.saveSettings();
				this.events.authUpdate(); // broadcast 'auth-updated' event after saving changes

				new Notice('Authentication successful!');
			} else {
				new Notice('Authentication failed.');
			}
		});

		await this.loadSettings();

		// adds a settings tab for the plugin
		this.addSettingTab(new GoogleDriveTab(this.app, this));

		// side ribbon button
		this.addRibbonIcon('orbit', 'WorldEdit', (e: MouseEvent) => {
			const menu = new Menu();

			const options = [
				{ title: 'Settings', icon: 'settings', action: () => new GoogleDriveModal(this.app, this).open() },
			];

			options.forEach(option => {
				menu.addItem(item => item
					.setTitle(option.title)
					.setIcon(option.icon)
					.onClick(option.action)
				);
			});
			menu.showAtMouseEvent(e); // displays selectmenu at click position
		}).addClass('ribbon');
	}

	async onunload() {
		console.log("Unloading WorldEdit plugin...");
	}
}

// ------------------------------------------------------------

class GoogleDriveTab extends PluginSettingTab {
	plugin: WorldEditPlugin;
	constructor(app: App, plugin: WorldEditPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		renderSettings(this);
	}
}

class GoogleDriveModal extends Modal {
	plugin: WorldEditPlugin;
	constructor(app: App, plugin: WorldEditPlugin) {
		super(app);
		this.plugin = plugin;
		this.setTitle('WorldEdit Settings');
	}
	onOpen() {
		renderSettings(this); // initial modal UI render

		// event listener to refresh modal UI with auth updates
		this.plugin.events.on('auth-updated', async () => {
			await this.plugin.loadSettings(); // reload latest settings
			renderSettings(this); // rerender modal UI
		});
	}

	onClose() {
		this.plugin.events.off('auth-updated', () => { }); // clean up event listener
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------

function authStatus(authSettings: UserAuth) {
	const { refreshToken, email } = authSettings;
	const attributes = refreshToken
		? `stroke="mediumpurple" class="lucide lucide-badge-check"`
		: `stroke="gray" class="lucide lucide-circle-alert"`;
	const paths = refreshToken
		? `<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>`
		: `<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>`;
	const statusText = refreshToken
		? email
		: 'Google authentication required!';

	return `<div class="header-container">
			<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${attributes}>${paths}</svg>
			<div class="header-status">${statusText}</div>
			</div>`;
}

function renderSettings(component: GoogleDriveTab | GoogleDriveModal) {
	const container: HTMLElement = component instanceof GoogleDriveModal
		? component.contentEl
		: component.containerEl;

	container.empty(); // clear existing content

	if (component instanceof GoogleDriveTab) {
		container.createEl("h2", { text: "WorldEdit Settings" });
	}

	const { settings, app } = component.plugin;

	// displays current auth status
	const statusHeader = container.createDiv({ cls: "header-status" });
	statusHeader.innerHTML = authStatus(settings.auth);

	// google refresh token input
	new Setting(container)
		.setName("Google refresh token")
		.setDesc("Set or update Google refresh token.")
		.addText(text => text
			.setPlaceholder("Enter refresh token...")
			.setValue(settings.auth.refreshToken)
			.onChange(input => {
				settings.auth.refreshToken = input;
			})
			.inputEl.setAttribute("type", "password")
		)
		.addButton(button => button
			.setButtonText(settings.auth.refreshToken ? "Renew" : "Obtain Token")
			.setClass("world-btn")
			.onClick(() => {
				const vaultName = app.vault.getName();
				window.open(`http://localhost:3000/auth?vault=${vaultName}`, "_blank");
			})
		);

	// gdrive sync folder selection
	if (settings.sync.rootFolders?.length > 0) {
		new Setting(container)
			.setName('Select your sync folder')
			.addDropdown(select => {
				select.addOption('', 'Select a folder');
				settings.sync.rootFolders.forEach(folder => {
					select.addOption(folder.id, folder.name);
				});

				select.setValue(settings.sync.selectedFolder.id); // set initial dropdown select value

				select.onChange(async value => {
					const selectedFolder = settings.sync.rootFolders.find(folder => folder.id === value);
					if (selectedFolder) {
						settings.sync.selectedFolder = selectedFolder;
					} else {
						settings.sync.selectedFolder = { id: '', name: '' };
					}

					renderSettings(component); // re-render on change
				});
				select.selectEl.classList.add('world-dropdown');
			})
			.addButton(button => button
				.setButtonText('Set Folder')
				.setClass('world-btn')
				.onClick(async () => {
					await component.plugin.saveSettings();
					new Notice('Sync folder updated!');
				})

				// disable button on placeholder option
				.buttonEl.disabled = settings.sync.selectedFolder.id === ''
			);
	}

	// // google drive obsidian folder id
	// new Setting(container)
	// 	.setName("Obsidian sync folder")
	// 	.setDesc("Google Drive directory for vault syncing.")
	// 	.addText(text => text
	// 		.setPlaceholder("Sync folder id...")
	// 		.setValue(settings.sync.folderId)
	// 		.onChange(input => {
	// 			settings.sync.folderId = input;
	// 		})
	// 	);

	const saveButton = container.createEl("button", { text: "Save", cls: "modal-btn" });
	saveButton.onclick = async () => {
		await component.plugin.saveSettings();
		new Notice("Settings saved!");

		if (component instanceof GoogleDriveModal) { component.close(); }
	};
}
