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
        accessExpiry: Date | null;
    }

    interface GoogleDriveConfig {
        auth: UserAuth;
        rootFolderId: string;
    }

    interface WorldEditSettings extends GitHubSettings, GoogleDriveConfig { }
}

export { };
