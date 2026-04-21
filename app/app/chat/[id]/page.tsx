import { ChatView } from "./chat-view";

export const metadata = { title: "Chat · ChatBrain" };

export default async function ChatPage({ params }: PageProps<"/app/chat/[id]">) {
  const { id } = await params;
  return <ChatView conversationId={id} />;
}
