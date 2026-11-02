# GitHub 提交指引（课程任务 1）

> 本机已完成：git 仓库初始化、4 次提交（1 基线 + 2 功能 + 1 测试 + 1 文档）、2 个标签（v1.0-baseline / v2.0-course）。
> 下面这几步需要**你本人**操作（要登录你的 GitHub 账号），照抄命令即可。

## 第 0 步 · 署名（可选但建议）

当前提交署名是占位的 `nau-student <nau-student@example.com>`。老师核查时显示真实姓名/学号更好：

```bash
cd /d/王建翔/life-ledger
git config --local user.name "你的姓名或学号"
git config --local user.email "你的邮箱"

# 把已有 4 次提交的署名统一改掉（非交互执行，直接整段粘贴）：
GIT_SEQUENCE_EDITOR=: GIT_EDITOR=true git rebase --root --exec "git commit --amend --reset-author --no-edit"
```

改完用 `git log --format="%h %an %s"` 检查，四条提交的作者都应变成你的名字。
（如果 rebase 命令报错，跳过这一步直接推送也不影响课程要求——提交次数和内容才是硬指标。）

## 第 1 步 · 在 GitHub 上建组织仓库

1. 登录 GitHub → 进入课程**组织**（Organization）
2. New repository → 仓库名建议 `life-ledger`
3. **不要**勾选 "Add a README"（否则会产生冲突提交，弄脏同步记录）
4. 记下仓库地址，形如 `https://github.com/<组织名>/life-ledger.git`

## 第 2 步 · 关联远程并推送

```bash
cd /d/王建翔/life-ledger
git remote add origin https://github.com/<组织名>/life-ledger.git
git push -u origin main --tags
```

首次推送会弹浏览器登录授权（或要求输入 Personal Access Token 当密码），按提示完成即可。

## 第 3 步 · 核查（对照课程要求）

- GitHub 仓库页面 → Commits：应看到 **4 条提交**（≥3 次同步记录 ✓）
- Tags：应看到 `v1.0-baseline` 和 `v2.0-course` 两个标签
- 本机核对命令：
  ```bash
  git log --oneline
  git ls-remote origin
  ```

## 常见问题

| 症状 | 处理 |
|---|---|
| push 提示 403 无权限 | 确认你在该组织里、且组织允许成员建仓/推送；或让管理员把仓库 Collaborator 加上你 |
| 提示 "failed to push some refs" | 说明远程非空（多半误勾了初始化 README）：`git pull origin main --allow-unrelated-histories` 后再 push |
| 想用 SSH 而不是 HTTPS | 先配好 SSH key，再把 remote 换成 `git@github.com:<组织名>/life-ledger.git` |

> ⚠️ 永远不要把 `.env`、真实密钥、其他同学的真实聊天截图之外的个人隐私提交进仓库。
