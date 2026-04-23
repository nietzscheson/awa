import { AwaVoiceChat } from "@/components/AwaVoiceChat";

export default function Home() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>My</h1>
      </header>
      <main>
        <AwaVoiceChat />
      </main>
    </div>
  );
}
