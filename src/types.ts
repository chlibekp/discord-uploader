export type MediaKind = "image" | "video";

export interface SniffResult {
  mime: string;
  ext: string;
  kind: MediaKind;
}

export type SessionKind = "upload" | "gallery";

export interface UploadSession {
  sid: string;
  kind: SessionKind;
  userId: string;
  channelId: string;
  guildId: string;
  interactionToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface FileRecord {
  id: string;
  name: string;
  mime: string;
  kind: MediaKind;
  size: number;
  width: number;
  height: number;
  createdAt: number;
  userId: string;
  channelId: string;
}
