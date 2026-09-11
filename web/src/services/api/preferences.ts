import { apiRequest } from "@/services/api/request";

export async function getPreferences<T extends Record<string, unknown>>() {
    return (await apiRequest<{ preferences: T }>("/api/preferences")).preferences;
}

export async function savePreferences<T extends Record<string, unknown>>(preferences: T) {
    return (await apiRequest<{ preferences: T }>("/api/preferences", { method: "PUT", body: preferences })).preferences;
}

export type ChangelogEntry = {
    date: string;
    tag: string;
    title: string;
    body: string;
};

export type Announcement = {
    title: string;
    content: string;
    entries: ChangelogEntry[];
    publishedAt: string;
};

export type AnnouncementDraft = Omit<Announcement, "publishedAt"> & {
    forceAlert?: boolean;
};

export async function getAnnouncement() {
    return (await apiRequest<{ announcement: Announcement }>("/api/announcement")).announcement;
}

export async function updateAnnouncement(draft: AnnouncementDraft) {
    return (await apiRequest<{ announcement: Announcement }>("/api/admin/announcement", { method: "PUT", body: draft })).announcement;
}

