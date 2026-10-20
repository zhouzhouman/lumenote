import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { currentUserId } from '@/lib/auth/authz';
import { AppNav } from '@/components/layout/app-nav';

/**
 * 受保护区域的服务端布局。
 *
 * ## 为什么鉴权放在服务端布局而不是每个页面
 *
 * 1. **一次校验覆盖整块区域**。新加的页面自动受保护，不会因为漏写检查而暴露
 * 2. **服务端渲染期就能判断**。未登录时直接 redirect，不存在「页面先闪一下再跳」的问题
 * 3. **拿得到用户信息**。可以在这里查一次用户，把 email 传给导航展示，
 *    避免每个页面都去查一遍数据库
 *
 * ⚠️ 但这**不是**唯一防线。真正的数据隔离在 API 层（authzTask 等），
 * 因为布局可以被绕过（直接调 API），布局只负责导航体验。
 * 两层都要有，缺一不可。
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const userId = await currentUserId();

  if (!userId) {
    // 带 next 参数，登录后能跳回原本想去的页面
    redirect('/login');
  }

  // 布局里查一次用户信息供导航展示。
  // select 只取需要的字段 —— 绝不把 passwordHash 带到客户端
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true },
  });

  // 用户理论上不会消失（session 有效即用户存在），但如果真的查不到，
  // 当作未登录处理比渲染一个空壳页面更安全
  if (!user) redirect('/login');

  return (
    <div className="flex min-h-screen">
      <AppNav email={user.email} />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}