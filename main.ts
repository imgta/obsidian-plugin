import { App, Events, Modal, Menu, Notice, Plugin, PluginManifest, PluginSettingTab, Setting, debounce } from 'obsidian';

const DEFAULT_SETTINGS: WorldEditSettings = {
	auth: {
		id: '',
		email: '',
		refreshToken: '',
		accessToken: '',
		accessExpiry: '',
	},
	sync: {
		vaultName: '',
		vaultRecord: {},
		rootFolders: [],
		selectedFolder: { id: '', name: '' },
		lastSync: '',
	}
};

// we can set custom app URI event listeners here
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

				// fetch google oauth tokens
				const res = await fetch('http://localhost:3000/api/vault/google/tokens', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ userId: id }),
				});
				const authTokens = await res.json();

				if (authTokens) {
					const { accessToken, expiry, refreshToken } = authTokens;
					this.settings.auth.accessToken = accessToken;
					this.settings.auth.refreshToken = refreshToken;
					this.settings.auth.accessExpiry = expiry;

					// scan gdrive root for folders
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
	savedFolderId: string; // set saved selection as local property
	constructor(app: App, plugin: WorldEditPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.savedFolderId = plugin.settings.sync.selectedFolder.id;
	}

	display(): void {
		renderSettings(this);
	}
}

class GoogleDriveModal extends Modal {
	plugin: WorldEditPlugin;
	savedFolderId: string; // set saved selection as local property
	constructor(app: App, plugin: WorldEditPlugin) {
		super(app);
		this.plugin = plugin;
		this.savedFolderId = plugin.settings.sync.selectedFolder.id;
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
				window.open(`http://localhost:3000/vault/auth?vault=${vaultName}`, "_blank");
			})
		);

	// gdrive sync folder selection
	if (settings.sync.rootFolders?.length > 0) {
		new Setting(container)
			.setName('Select your sync folder')
			.setDesc('Google Drive folder to store Obsidian vault files.')
			.addDropdown(select => {
				select.addOption('', 'Select a folder');
				settings.sync.rootFolders.forEach(folder => {
					select.addOption(folder.id, folder.name);
				});
				select.setValue(settings.sync.selectedFolder.id); // set initial dropdown value

				select.onChange(async value => {
					// check if folder exists in gdrive root directory
					const selectedFolder = settings.sync.rootFolders.find(folder => folder.id === value);
					if (selectedFolder) {
						settings.sync.selectedFolder = selectedFolder;
					} else {
						settings.sync.selectedFolder = { id: '', name: '' };
					}

					renderSettings(component); // rerender settings UI
				});
				select.selectEl.classList.add('world-dropdown');
			})
			.addButton(button => button
				.setButtonText('Set Folder')
				.setClass('world-btn')
				.onClick(async () => {
					component.savedFolderId = settings.sync.selectedFolder.id;
					await component.plugin.saveSettings();
					new Notice('Sync folder updated!');
				})

				// disable button on empty placeholder option
				.buttonEl.disabled = !settings.sync.selectedFolder.id || settings.sync.selectedFolder.id === component.savedFolderId
			);
	}

	// sync obsidian vault files
	new Setting(container)
		.setName('Sync Obsidian vault files')
		.setDesc('Sync Obsidian vault files to Google Drive.')
		.addButton(button => button
			.setButtonText('Sync')
			.setClass('world-btn')
			.onClick(async () => {
				await syncVault(component.plugin);
			})
			.setTooltip(`Last synced: ${humanDate(settings.sync.lastSync)}`, { delay: 100 })
		);

	const saveButton = container.createEl('button', { text: 'Save', cls: ['modal-btn', 'world-btn'] });
	saveButton.onclick = async () => {
		await component.plugin.saveSettings();
		new Notice('Settings saved!');

		if (component instanceof GoogleDriveModal) { component.close(); }
	};
}

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

/**
 * Converts UNIX timestamp to MMM DD, YYYY HH:MM AM/PM
 *
 * @param timestamp - A date object or string to be converted.
 * @param showTime - A boolean indicating whether to show the HH:MM AM/PM time.
 * @returns The human readable date string
 */
function humanDate(timestamp: Date | string, showTime = true) {
	const date = new Date(timestamp);
	const params: Record<string, string> = { year: 'numeric', month: 'short', day: 'numeric' };

	if (showTime) {
		params.hour = 'numeric';
		params.minute = 'numeric';
	}

	return date.toLocaleDateString('en-US', params);
}

// ------------------------------------------------------------

async function syncVault(plugin: WorldEditPlugin) {
	const syncStatus = new Notice('Starting sync!');
	const { settings, app } = plugin;
	const vaultName = settings.sync.vaultName;
	const rootFolderId = settings.sync.selectedFolder.id;

	// refresh access token if expired
	const now = new Date();
	const tokenExpired = now >= new Date(settings.auth.accessExpiry);
	if (tokenExpired) {
		const tokensRes = await fetch('http://localhost:3000/api/vault/google/tokens', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: plugin.settings.auth.id }),
		});
		const { accessToken, expiry, refreshToken } = await tokensRes.json();
		settings.auth.accessToken = accessToken;
		settings.auth.refreshToken = refreshToken;
		settings.auth.accessExpiry = expiry;
		await plugin.saveSettings();
	}

	// create subfolder with vaultName in selectedFolder if it doesn't already exist
	let vaultFolderId = '';
	const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
		`name='${vaultName}' and '${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
	)}&fields=files(id,name)`, {
		method: 'GET',
		headers: { 'Authorization': `Bearer ${settings.auth.accessToken}` },
	});
	const searchData = await searchRes.json();
	if (searchData.files && searchData.files.length > 0) { // folder exists, use its folderId
		vaultFolderId = searchData.files[0].id;
	} else {
		const createFolderRes = await fetch('https://www.googleapis.com/drive/v3/files', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${settings.auth.accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				name: vaultName,
				mimeType: 'application/vnd.google-apps.folder',
				parents: [rootFolderId],
			}),
		});
		const createFolderData = await createFolderRes.json();
		if (!createFolderData.id) {
			console.error('Failed to create subfolder:', createFolderData);
			new Notice('Failed to create vault subfolder.');
			return;
		}
		vaultFolderId = createFolderData.id;
		console.log(`New vault folder '${vaultName}' created: ${vaultFolderId}`);
	}

	// process vault file upserts to google drive in batches
	const files = app.vault.getFiles();
	const batchSize = 5;
	for (let i = 0; i < files.length; i += batchSize) {
		const batch = files.slice(i, i + batchSize);

		await Promise.all(batch.map(async file => {
			// skip processing unchanged files
			const fileModTime = file.stat.mtime;
			const fileRecord = settings.sync.vaultRecord[file.path];
			if (fileRecord?.lastModified >= fileModTime) {
				console.log(`Skipping unchanged file: ${file.path}`);
				return Promise.resolve();
			}

			const isUpdate = !!fileRecord?.gdriveId; // determine if update or new file

			// construct formdata object for google drive api call
			const fileBuffer = ['md', 'txt'].includes(file.extension)
				? await app.vault.read(file)
				: await app.vault.readBinary(file);
			const fileBlob = new Blob([fileBuffer], { type: getMimeType(file.extension) });
			const metadataBlob = new Blob(
				[
					JSON.stringify({
						name: file.path,
						...(isUpdate ? {} : { parents: [vaultFolderId] }), // exclude parents field if updating
					})
				],
				{ type: 'application/json' }
			);
			const formData = new FormData();
			formData.append('metadata', metadataBlob);
			formData.append('file', fileBlob);

			// upsert vault file to google drive
			const uploadURI = isUpdate
				? `https://www.googleapis.com/upload/drive/v3/files/${fileRecord.gdriveId}?uploadType=multipart`
				: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
			const upsertRes = await fetch(uploadURI, {
				method: isUpdate ? 'PATCH' : 'POST',
				headers: { 'Authorization': `Bearer ${settings.auth.accessToken}` },
				body: formData,
			});
			const upserted = await upsertRes.json();

			if (!upserted.id) {
				console.error(`Failed to upsert ${file.path}:`, upserted);
				new Notice(`Failed to upsert ${file.path}`);
				return;
			}
			console.log(`File ${file.path} upserted: ${upserted.id}`);

			// update file's vault record
			settings.sync.vaultRecord[file.path] = { gdriveId: upserted.id, lastModified: fileModTime };
		}));
	}

	// prune locally deleted vault files from google drive
	const localPaths = new Set(files.map(file => file.path));
	const deletePromises = Object.entries(settings.sync.vaultRecord).map(async ([filePath, record]) => {
		if (!localPaths.has(filePath)) {
			const deleteRes = await fetch(`https://www.googleapis.com/drive/v3/files/${record.gdriveId}`, {
				method: 'DELETE',
				headers: { 'Authorization': `Bearer ${settings.auth.accessToken}` },
			});
			if (deleteRes.ok) {
				console.log(`Google Drive file removed: ${filePath}`);
				delete settings.sync.vaultRecord[filePath];
			} else {
				console.error(`Failed to delete file: ${filePath}`);
				new Notice(`Failed to delete ${filePath} from Google Drive`);
			}
		}
	});
	await Promise.all(deletePromises);

	// update last sync timestamp
	settings.sync.lastSync = new Date().toISOString();

	// debounce notice update with 500ms delay
	const updateSyncStatus = debounce((text: string) => { syncStatus.setMessage(text); }, 500, true);
	updateSyncStatus('Google Drive sync complete!');
	await plugin.saveSettings();
}

function getMimeType(extension: string): string {
	switch (extension) {
		case 'md': return 'text/markdown';
		case 'txt': return 'text/plain';
		case 'png': return 'image/png';
		case 'jpg':
		case 'jpeg': return 'image/jpeg';
		case 'gif': return 'image/gif';
		case 'webp': return 'image/webp';
		case 'pdf': return 'application/pdf';
		case 'json': return 'application/json';
		case 'svg': return 'image/svg+xml';
		case 'mp3': return 'audio/mpeg';
		case 'mp4': return 'video/mp4';
		case 'ogg': return 'video/ogg';
		default: return 'application/octet-stream'; // default for unknown types
	}
}
