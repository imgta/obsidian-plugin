declare global {
    interface GitHubSettings {
        githubUser?: string;
        repositoryUrl?: string;
        personalAccessToken?: string;
        githubVerified?: boolean;
    }

    interface UserAuth {
        id: string;
        email: string;
        refreshToken: string;
        accessToken: string;
        accessExpiry: string;
    }

    interface GoogleDriveFileParams {
        id: string;
        name: string;
        mimeType?: string;
        size?: number;
        createdTime?: Date | string;
        modifiedTime?: Date | string;
    }

    interface VaultFileRecord {
        gdriveId: string;
        lastModified: number; // modification time in ms
    }

    interface GoogleDriveConfig {
        auth: UserAuth;
        sync: {
            vaultName: string;
            vaultRecord: { [filePath: string]: VaultFileRecord; };
            rootFolders: GoogleDriveFileParams[];
            selectedFolder: GoogleDriveFileParams;
            lastSync: Date | string;
        };
    }

    interface WorldEditSettings extends GitHubSettings, GoogleDriveConfig { }
}

export { };
