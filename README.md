# 网课资料

从 [Andyyyds](https://github.com/yydsxwh/Andyyyds) 拆出的网课资料产品：课程广场、资料广场、在线学习、创作者中心与素材库。

## 功能

- 课程广场 / 资料广场（搜索、分类、页内 Tab 切换）
- 课程与资料详情、试看、购买
- 模拟支付与优惠券（`YYDS20`）
- 我的学习 / 课时播放 / 进度标记 / 资料下载
- 直播课占位
- 创作者中心：上架单课、专栏、资料包，查看订单与学习进度
- 素材中心：上传视频与附件、自由分类、长命名（最多 200 字）
- 创建课程：多选素材生成可售「单课」或「专栏」
- 三级分销：后台可设一/二/三级比例，下级付费自动结算佣金

## 技术栈

- Next.js 16 + TypeScript + Tailwind CSS
- Prisma + SQLite
- Cookie Session（jose + bcryptjs）

## 快速开始

```bash
npm install
npm run db:reset
npm run dev
```

浏览器打开 [http://localhost:3000/courses](http://localhost:3000/courses)

### 演示账号

| 角色 | 邮箱 | 密码 |
|------|------|------|
| 学员 | student@yyds.local | 123456 |
| 讲师 | teacher@yyds.local | 123456 |
| 管理员 | admin@yyds.local | 123456 |

优惠券：`YYDS20`（满 99 减 20）

## 主要路径

| 路径 | 说明 |
|------|------|
| `/courses` | 课程广场 |
| `/materials` | 资料广场 |
| `/courses/[slug]` / `/materials/[slug]` | 详情与购买 |
| `/learn` / `/learn/[slug]` | 我的学习 / 播放 |
| `/studio/courses` | 我的课程 |
| `/studio/materials` | 我的资料 |
| `/studio/courses/compose` | 用素材合成单课/专栏 |
| `/studio/media` | 素材中心 |

## 目录

- `packages/courses`（`@andyyyds/courses`）网课资料页面、API 与组件
- `packages/shared`（`@andyyyds/shared`）登录、支付、权限、存储、国际化等公共能力
- `src/app` 站点路由与 API 薄封装（URL 与原站一致）
- `src/components` 站点壳 UI（导航、装修、支付页等）
- `prisma` 数据模型与种子数据
