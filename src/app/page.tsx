import { redirect } from "next/navigation";

/** 本库以网课资料为主产品，首页进入课程广场（资料广场在页内 Tab）。 */
export default function HomePage() {
  redirect("/courses");
}
