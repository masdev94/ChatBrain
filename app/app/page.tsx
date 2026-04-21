import { redirect } from "next/navigation";

export default function AppIndex() {
  // Default landing inside the protected area is the knowledge base.
  redirect("/app/sources");
}
