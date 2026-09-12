import { apiRequest } from "@/services/api/request";
import type { PublicModel } from "./generation";

export type { PublicModel } from "./generation";

export async function listModels() {
    return (await apiRequest<{ models: PublicModel[] }>("/api/models")).models;
}
