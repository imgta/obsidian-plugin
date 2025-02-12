import { App, Events, Modal, Menu, Notice, Plugin, PluginManifest, PluginSettingTab, Setting, debounce, TFile } from 'obsidian';

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
			.setPlaceholder("Refresh token unset...")
			.setValue(settings.auth.refreshToken)
			.onChange(input => {
				settings.auth.refreshToken = input;
			})
			.inputEl.setAttribute("type", "password")
		)
		.setDisabled(true)
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
					renderSettings(component); // rerender settings UI
					new Notice('Sync folder updated!');
				})

				// disable button on empty placeholder option
				.buttonEl.disabled = !settings.sync.selectedFolder.id || settings.sync.selectedFolder.id === component.savedFolderId
			);
	}

	if (component.savedFolderId) {
		// obsidian vault to google drive push sync
		new Setting(container)
			.setName('Sync Obsidian vault to Google Drive')
			.setDesc('Push Obsidian vault files to Google Drive.')
			.addButton(button => button
				.setButtonText('Push Sync')
				.setClass('world-btn')
				.onClick(async () => {
					await syncVaultToDrive(component.plugin);
				})
				.setTooltip(`Last synced: ${settings.sync.lastSync ? humanDate(settings.sync.lastSync) : 'never'}`, { delay: 100 })
			);

		// google drive to obsidian vault pull sync
		new Setting(container)
			.setName('Sync Google Drive to Obsidian vault')
			.setDesc('Pull Google Drive files into Obsidian vault.')
			.addButton(button => button
				.setButtonText('Pull Sync')
				.setClass('world-btn')
				.onClick(async () => {
					await syncDriveToVault(component.plugin);
				})
				.setTooltip(`Last synced: ${settings.sync.lastSync ? humanDate(settings.sync.lastSync) : 'never'}`, { delay: 100 })
			);
	}

	// new Setting(container)
	// 	.setName('Test')
	// 	.addButton(button => button
	// 		.setButtonText('Test')
	// 		.setClass('world-btn')
	// 		.onClick(async () => {
	// 			console.log('app.vault.getRoot()', app.vault.getRoot());
	// 			console.log('app.vault.getFiles()', app.vault.getFiles());
	// 		})
	// 	);

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

async function validateAuthTokens(plugin: WorldEditPlugin) {
	const { settings } = plugin;
	const now = new Date();

	// refresh access token if expired
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

	return settings.auth.accessToken;
}

async function validateDriveFolder(accessToken: string, parentFolderId: string, folderName: string) {
	const query = encodeURIComponent(
		`name='${folderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
	);
	const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`, {
		method: 'GET',
		headers: { 'Authorization': `Bearer ${accessToken}` },
	});
	const searchData = await searchRes.json();

	// folder exists--return the folder id
	if (searchData.files.length > 0) { return searchData.files[0].id; }

	// folder not found--create it and return the folder id
	const folderRes = await fetch('https://www.googleapis.com/drive/v3/files', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			name: folderName,
			mimeType: 'application/vnd.google-apps.folder',
			parents: [parentFolderId],
		}),
	});
	const folderData = await folderRes.json();
	if (!folderData.id) {
		console.error('Failed to create subfolder:', folderName);
		new Notice('Failed to create subfolder.');
	}
	return folderData.id;
}

async function syncVaultToDrive(plugin: WorldEditPlugin) {
	const syncStatus = new Notice('Starting (push) sync...');
	const { settings, app } = plugin;
	const vaultName = settings.sync.vaultName;
	const rootFolderId = settings.sync.selectedFolder.id;
	const syncResults: { [operation: string]: string[]; } = {
		skips: [],
		upserts: [],
		deletes: [],
	};

	// get valid access token, refreshing if expired
	const accessToken = await validateAuthTokens(plugin);

	// verify vault folder exists in drive
	const vaultFolderId = await validateDriveFolder(accessToken, rootFolderId, vaultName);

	// process vault file upserts to google drive in batches
	const files = app.vault.getFiles();
	const CONCURRENCY_LIMIT = 5;

	for (let i = 0; i < files.length; i += CONCURRENCY_LIMIT) {
		const batch = files.slice(i, i + CONCURRENCY_LIMIT);
		await Promise.all(batch.map(async file => {
			// skip processing unchanged files
			const fileModTime = file.stat.mtime;
			const fileRecord = settings.sync.vaultRecord[file.path];
			if (fileRecord?.lastModified >= fileModTime) {
				syncResults.skips.push(file.path);
				return Promise.resolve();
			}

			const pathParts = file.path.split('/');
			const fileName = pathParts.pop() ?? file.name;
			let currentFolderId = vaultFolderId;

			// create necessary subfolders for nested files
			if (pathParts.length > 0) {
				for (const folderName of pathParts) {
					currentFolderId = await validateDriveFolder(accessToken, currentFolderId, folderName);
				}
			}

			// build formdata for google drive api call
			const fileBuffer = ['md', 'txt', 'json'].includes(file.extension)
				? await app.vault.read(file)
				: await app.vault.readBinary(file);
			const fileBlob = new Blob([fileBuffer], { type: getMimeType(file.extension) });

			const isUpdate = !!fileRecord?.gdriveId; // determine if update or new file

			// prep metadata and formdata
			const metadataObj = {
				name: fileName,
				parents: isUpdate ? undefined : [currentFolderId], // exclude parents field if updating
			};

			const metadataBlob = new Blob(
				[JSON.stringify(metadataObj)],
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
				headers: { 'Authorization': `Bearer ${accessToken}` },
				body: formData,
			});
			const upserted = await upsertRes.json();

			if (!upserted.id) {
				console.error(`Failed to upsert ${file.path}:`, upserted);
				new Notice(`Failed to upsert ${file.path}`);
				return Promise.resolve();
			}
			syncResults.upserts.push(file.path);

			// update file's vault record
			settings.sync.vaultRecord[file.path] = { gdriveId: upserted.id, lastModified: fileModTime };
		}));
	}

	// prune locally deleted vault files from remote google drive
	const localPaths = new Set(files.map(file => file.path));
	const deletePromises = Object.entries(settings.sync.vaultRecord).map(async ([filePath, fileRecord]) => {
		if (!localPaths.has(filePath)) {
			const deleteRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileRecord.gdriveId}`, {
				method: 'DELETE',
				headers: { 'Authorization': `Bearer ${accessToken}` },
			});
			if (deleteRes.ok) {
				syncResults.deletes.push(filePath);
				delete settings.sync.vaultRecord[filePath];
			} else {
				console.error(`Failed to delete file: ${filePath}`);
				new Notice(`Failed to delete ${filePath} from Google Drive`);
			}
		}
	});
	await Promise.all(deletePromises);

	// update last sync timestamp and save settings
	settings.sync.lastSync = new Date().toISOString();
	await plugin.saveSettings();

	// debounce sync status notice update with 500ms delay
	const updateSyncStatus = debounce((text: string) => { syncStatus.setMessage(text); }, 500, true);
	updateSyncStatus('Google Drive sync complete!');
	console.log(syncResults);
}

async function syncDriveToVault(plugin: WorldEditPlugin) {
	const syncStatus = new Notice('Starting (pull) sync...');
	const { settings, app } = plugin;
	const vaultName = settings.sync.vaultName;
	const rootFolderId = settings.sync.selectedFolder.id;
	const syncResults: { [operation: string]: string[]; } = {
		skips: [],
		upserts: [],
		deletes: [],
	};

	// get valid access token, refreshing if expired
	const accessToken = await validateAuthTokens(plugin);

	// verify vault folder exists in drive
	const vaultFolderId = await validateDriveFolder(accessToken, rootFolderId, vaultName);

	// create a map of file paths to drive files for easier lookups
	const driveFileMap = new Map();
	const CONCURRENCY_LIMIT = 5;
	const folderQueue: { id: string, path: string[]; }[] = [{ id: vaultFolderId, path: [] }];

	// recursively iterate through all parent folders to get all files in vault folder
	while (folderQueue.length > 0) {
		const currentBatch = folderQueue.splice(0, CONCURRENCY_LIMIT);

		const batchResults = await Promise.all(
			currentBatch.map(async folderItem => {
				const folderFiles: any = { files: [], folderItem };
				const query = encodeURIComponent(`'${folderItem.id}' in parents and trashed = false`);
				const fields = 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime)';
				let pageToken: string | undefined = undefined;
				do {
					try {
						const listURL = pageToken
							? `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&pageToken=${pageToken}`
							: `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}`;
						const res = await fetch(listURL, {
							method: 'GET',
							headers: { 'Authorization': `Bearer ${accessToken}` },
						});
						const listData = await res.json();

						folderFiles.files.push(...(listData.files || []));
						pageToken = listData.nextPageToken || undefined;
					} catch (error) {
						console.error('Error fetching folder contents:', error);
					}
				} while (pageToken);

				return folderFiles;
			})
		);

		for (const { files, folderItem } of batchResults) {
			for (const file of files) {
				const filePath = [...folderItem.path, file.name];

				// add folders to queue for further processing
				if (file.mimeType === 'application/vnd.google-apps.folder') {
					folderQueue.push({ id: file.id, path: filePath });
				} else { // add files to our file map
					driveFileMap.set(filePath.join('/'), file);
				}
			}
		}
	}

	// process drive file syncing in batches
	const drivePaths = Array.from(driveFileMap.keys());
	console.log('Drive files found:', drivePaths);

	for (let i = 0; i < drivePaths.length; i += CONCURRENCY_LIMIT) {
		const batch = drivePaths.slice(i, i + CONCURRENCY_LIMIT);

		await Promise.all(batch.map(async filePath => {
			const driveFile = driveFileMap.get(filePath);
			const fileRecord = settings.sync.vaultRecord[filePath];
			const localFile = app.vault.getAbstractFileByPath(filePath);

			// if file exists locally and hasn't been modified, skip it
			if (localFile && fileRecord?.gdriveId === driveFile.id) {
				const driveModTime = new Date(driveFile.modifiedTime).getTime();
				const localModTime = localFile instanceof TFile ? localFile.stat.mtime : 0;
				console.log({ driveModTime, localModTime });
				if (localModTime >= driveModTime) {
					console.log('UP TO DATE!');
					syncResults.skips.push(filePath);
					return Promise.resolve();
				}
			}

			// determine if file is non-downloadable, non-binary editor file (i.e. google docs, sheets, etc)
			const isEditorFile = driveFile.mimeType.startsWith('application/vnd.google-apps');
			const driveURL = `https://www.googleapis.com/drive/v3/files/${driveFile.id}` +
				(isEditorFile
					? `/export?mimeType=text/markdown` // if editor file, export content instead
					: '?alt=media');

			const updateRes = await fetch(driveURL, {
				method: 'GET',
				headers: { 'Authorization': `Bearer ${accessToken}` },
			});

			try {
				if (!localFile) { // ensure parent folders exist
					const folderPath = filePath.split('/').slice(0, -1).join('/');
					if (folderPath) {
						await app.vault.createFolder(folderPath).catch(() => {
							// folder already exists, ignore error
							console.log(`Folder already exists: ${folderPath}`);
						});
					}
				}
				if (isEditorFile) {
					const newContent = await updateRes.text();
					await app.vault.modify(localFile as TFile, newContent);
				} else {
					const newBinary = await updateRes.arrayBuffer();
					await app.vault.adapter.writeBinary(filePath, newBinary);
				}

				// update sync results and vault record
				syncResults.upserts.push(filePath);
				settings.sync.vaultRecord[filePath] = {
					gdriveId: driveFile.id,
					lastModified: new Date(driveFile.modifiedTime).getTime(),
				};
			} catch (error) {
				console.error(`Failed to sync file ${filePath}:`, error);
				new Notice(`Failed to sync ${filePath}`);
			}
		}));
	}

	// delete local files that no longer exist in drive
	const localFiles = app.vault.getFiles();
	for (const file of localFiles) {
		if (!driveFileMap.has(file.path) && settings.sync.vaultRecord[file.path]) {
			try {
				await app.vault.delete(file);
				delete settings.sync.vaultRecord[file.path];
				syncResults.deletes.push(file.path);
			} catch (error) {
				console.error(`Failed to delete file ${file.path}:`, error);
				new Notice(`Failed to delete ${file.path}`);
			}
		}
	}

	// update last sync timestamp and save settings
	settings.sync.lastSync = new Date().toISOString();
	await plugin.saveSettings();

	// debounce sync status notice update with 500ms delay
	const updateSyncStatus = debounce((text: string) => { syncStatus.setMessage(text); }, 500, true);
	updateSyncStatus('Vault sync complete!');
	console.log(syncResults);
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
