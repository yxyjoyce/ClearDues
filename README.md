# 随手记｜欠款与还款账本

手机优先的简体中文人民币 PWA，用于个人记录“我欠别人”和“别人欠我”的债务、还款及到期信息。使用邮箱+密码注册/登录；金额在客户端输入为元，数据库按分（整数）保存。

## 运行

```bash
npm install
npm run dev
```

生产构建会先执行 TypeScript 项目检查：

```bash
npm test
npm run build
```

## Supabase 配置

1. 在 Supabase 项目中执行 `supabase/migrations/202609040001_create_ledger.sql`。
2. 复制 `.env.example` 为 `.env.local`，填写 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_PUBLISHABLE_KEY`。
3. 在 Supabase Auth 中启用 Email 和密码登录；如果启用了邮箱确认，请把本地/生产地址加入 Site URL 与 Redirect URLs。

客户端只读取 URL 与 Publishable Key。绝不要把 `service_role`、`sb_secret` 或其他服务端密钥放进 Vite 环境变量、前端代码或浏览器。数据库依靠每张表的 RLS 和 `auth.uid() = user_id` 隔离用户。

## 离线与同步

债务和还款先写入 Dexie IndexedDB，同时写入 outbox；联网且登录后会按实体合并待同步变更，再拉取用户数据。冲突比较 `updated_at`，服务端较新的记录获胜；软删除使用 tombstone，避免离线删除在同步时复活。没有有效 Supabase 环境变量时，界面会明确显示未配置同步，不会尝试远程连接。

本地演示数据只有显式设置 `VITE_ENABLE_DEMO=true` 时启用；生产默认关闭。演示模式不代表认证或多设备同步已配置。

## 安全与限制

- 这是个人账本；首版没有多人共享、预算、周期账单、OCR 或银行卡导入。
- 邮箱确认、邮箱+密码登录和真实跨设备同步必须连接用户自己的 Supabase 项目后验证；应用不发送登录魔法链接。
- 删除是软删除，数据库仍保留记录以支持冲突收敛；当前没有用户自助永久清除界面。
- PWA 的 service worker 由 `vite-plugin-pwa` 在生产构建时生成，开发服务器不代表已安装或离线缓存验证通过。
