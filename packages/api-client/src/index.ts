import { z } from 'zod';
import { BuildingMutationBatchSchema, BuildingTypeSchema } from '@aihd/domain';

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(120),
  buildingType: BuildingTypeSchema.default('home'),
  workspaceId: z.string().uuid(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const CreateOrganizationSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9-]+$/),
});
export type CreateOrganizationInput = z.infer<typeof CreateOrganizationSchema>;

export const ApplyMutationSchema = z.object({
  projectId: z.string().uuid(),
  batch: BuildingMutationBatchSchema,
});
export type ApplyMutationInput = z.infer<typeof ApplyMutationSchema>;

export const ChatMessageSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(8000),
  selectedEntityId: z.string().min(1).nullable().optional(),
});
export type ChatMessageInput = z.infer<typeof ChatMessageSchema>;

export const CreateCheckoutSchema = z.object({
  workspaceId: z.string().uuid(),
  plan: z.enum(['pro', 'team', 'enterprise']),
  seatCount: z.number().int().positive().default(1),
});
export type CreateCheckoutInput = z.infer<typeof CreateCheckoutSchema>;

export const CreateApiKeySchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().min(1).max(80),
  scopes: z.array(z.string()).default(['projects:read']),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;

export async function apiFetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, {
    ...init,
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
