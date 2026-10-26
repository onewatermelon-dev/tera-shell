/**
 * SFTP 内置预览的分流判定：图片/文本扩展名命中、无扩展名约定文件、
 * 不认识的扩展名返回 null（走外部打开）。
 */
import { describe, expect, it } from "vitest";
import {
  baseNameOf,
  previewKind
} from "@/sftp/lib/preview";

describe("previewKind", () => {
  it("图片扩展名（含大写）识别为 image", () => {
    expect(previewKind("logo.png")).toBe("image");
    expect(previewKind("photo.JPG")).toBe(
      "image"
    );
    expect(previewKind("icon.svg")).toBe("image");
  });

  it("文本/配置/代码扩展名识别为 text", () => {
    expect(previewKind("app.log")).toBe("text");
    expect(previewKind("config.yaml")).toBe(
      "text"
    );
    expect(previewKind("main.rs")).toBe("text");
    expect(previewKind(".env")).toBe("text");
  });

  it("无扩展名的约定文件按文本", () => {
    expect(previewKind("Makefile")).toBe("text");
    expect(previewKind("Dockerfile")).toBe(
      "text"
    );
  });

  it("不认识的扩展名返回 null（外部打开）", () => {
    expect(
      previewKind("archive.tar.gz")
    ).toBeNull();
    expect(previewKind("data.bin")).toBeNull();
    expect(previewKind("app.exe")).toBeNull();
  });
});

describe("baseNameOf", () => {
  it("两种分隔符都切", () => {
    expect(baseNameOf("/var/log/app.log")).toBe(
      "app.log"
    );
    expect(baseNameOf("D:\\logs\\a.txt")).toBe(
      "a.txt"
    );
  });
});
