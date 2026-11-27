import { redirect } from "next/navigation";

/** Früher eigener Menüpunkt „Mein Postfach“ – jetzt Teil der E-Mail-Einstellungen */
export default function MyMailboxRedirect() {
  redirect("/admin/email");
}
