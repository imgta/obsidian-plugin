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
        createdTime?: string;
        modifiedTime?: string;
    }

    interface GoogleDriveConfig {
        auth: UserAuth;
        sync: {
            rootFolders: GoogleDriveFileParams[];
            selectedFolder: GoogleDriveFileParams;
            vaultName: string;
            lastSynced: number | null;
        };
    }

    interface WorldEditSettings extends GitHubSettings, GoogleDriveConfig { }
}

export { };
