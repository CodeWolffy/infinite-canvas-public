import { apiRequest } from "@/services/api/request";

export type PublicModel = {
    id: string;
    name: string;
    displayName: string;
    capability: "image" | "text" | "video" | "audio";
    price?: string;
    sortOrder: number;
    description: string | null;
};

export async function listModels() {
    return (await apiRequest<{ models: PublicModel[] }>("/api/models")).models;
}
