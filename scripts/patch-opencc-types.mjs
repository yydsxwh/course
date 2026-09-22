/**
 * @yydsxwh/shared 把 OpenCC.Converter 当成函数使用。
 * opencc-js 1.4 的类型在 Next 类型检查里被收成 { convert }，构建因此失败。
 * 运行时仍是函数。这里只加断言，不改转换行为。
 */
import fs from "node:fs";

const path = new URL(
  "../node_modules/@yydsxwh/shared/src/i18n/opencc.ts",
  import.meta.url,
);
const file = path.pathname;
const text = fs.readFileSync(file, "utf8");
const from = `  s2t = OpenCC.Converter({ from: "cn", to: "tw" });
  t2s = OpenCC.Converter({ from: "tw", to: "cn" });`;
const to = `  s2t = OpenCC.Converter({ from: "cn", to: "tw" }) as unknown as Converter;
  t2s = OpenCC.Converter({ from: "tw", to: "cn" }) as unknown as Converter;`;

if (text.includes(to)) {
  console.log("opencc types already patched");
} else if (!text.includes(from)) {
  console.error("opencc patch target missing");
  process.exit(1);
} else {
  fs.writeFileSync(file, text.replace(from, to));
  console.log("patched opencc types");
}
