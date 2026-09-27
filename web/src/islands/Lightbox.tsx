import type { ApiFile } from "@server/me/types";

interface Props {
  files: ApiFile[];
  openId: string;
  onClose(): void;
  onNavigate(id: string): void;
  onDelete(file: ApiFile): Promise<void>;
}

/** Stub until Task 17 lands the real viewer. */
export default function Lightbox(_props: Props) {
  return null;
}
