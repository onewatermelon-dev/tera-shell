// 远程归档菜单的压缩包识别。
//
// 为什么单独测：解压项只对压缩包点亮，扩展名判错会出现「点了没反应」
// 或「对普通文件可解压」的假按钮。
import { describe, expect, it } from "vitest";
import { isArchiveName } from "@/sftp/lib/sftpUtils";

describe("isArchiveName", () => {
  it("识别 tar 系与 zip", () => {
    expect(isArchiveName("site.tar.gz")).toBe(
      true
    );
    expect(isArchiveName("site.tgz")).toBe(true);
    expect(isArchiveName("dump.tar.bz2")).toBe(
      true
    );
    expect(isArchiveName("dump.tbz2")).toBe(true);
    expect(isArchiveName("kernel.tar.xz")).toBe(
      true
    );
    expect(isArchiveName("kernel.txz")).toBe(
      true
    );
    expect(isArchiveName("backup.tar")).toBe(
      true
    );
    expect(isArchiveName("backup.zip")).toBe(
      true
    );
  });

  it("大小写不敏感", () => {
    expect(isArchiveName("SITE.TAR.GZ")).toBe(
      true
    );
  });

  it("普通文件与伪装扩展名不误判", () => {
    expect(isArchiveName("nginx.conf")).toBe(
      false
    );
    expect(isArchiveName("photo.png")).toBe(
      false
    );
    // .gz 单独不算（tar -xf 解不了纯 gzip 的单文件语义不明确）
    expect(isArchiveName("access.log.gz")).toBe(
      false
    );
    // tar.gz 必须以扩展名结尾
    expect(isArchiveName("site.tar.gz.bak")).toBe(
      false
    );
  });
});
