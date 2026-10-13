"use client";

import { useT } from "@/settings/lib/i18n";
import controlStyles from "./PromptInputControls.module.css";

/** 待发送的图片缩略图条（data URL，由父级持有；发送后由父级清空）。 */
export function PromptAttachments({
  images,
  onRemoveImage
}: {
  /** 待发送的图片（data URL） */
  images: string[];
  onRemoveImage: (index: number) => void;
}) {
  const t = useT();
  return (
    <div className={controlStyles.attachments}>
      {images.map((url, index) => (
        <span
          key={`${index}-${url.slice(-24)}`}
          className={controlStyles.thumb}
        >
          <img
            src={url}
            alt=""
            className={controlStyles.thumbImg}
          />
          <button
            type="button"
            className={controlStyles.thumbRemove}
            aria-label={t("ai.menu.removeImage")}
            onClick={() => onRemoveImage(index)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
