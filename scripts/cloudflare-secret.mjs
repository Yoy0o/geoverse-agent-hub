import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const filename = path.resolve(".cloudflare/bootstrap-secrets.json");
await mkdir(path.dirname(filename), { recursive: true });
try {
  await writeFile(filename, JSON.stringify({ HUB_TOKEN: randomBytes(32).toString("base64url") }) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`独立云端密钥已保存到 ${filename}；没有显示密钥值。`);
  console.log("请在本机编辑器中查看并存入密码管理器；上传成功后删除该明文文件，不要提交或粘贴到聊天。");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.error("密钥文件已存在，未覆盖。请保存已有密钥并确认部署状态后再处理。");
  process.exitCode = 1;
}
