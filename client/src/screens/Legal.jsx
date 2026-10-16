// DRAFT legal pages. Have a lawyer review and fill in the bracketed details before launch.

function Privacy() {
  return (
    <>
      <h1 className="find-title">Privacy</h1>
      <p className="draft">Draft: not yet reviewed by a lawyer.</p>
      <p>Kindred lets adults talk anonymously. We collect as little as we can and never show your email or real name to anyone unless you choose to reveal it through Connect.</p>
      <h2>What we store</h2>
      <ul>
        <li><strong>Account:</strong> email, birthdate (to confirm you're 18+), a hashed password, and your random anonymous name.</li>
        <li><strong>Conversations:</strong> the messages you send and receive, so you can continue chats later.</li>
        <li><strong>Safety records:</strong> reports, blocks, and messages our filters held back. If you unsend a message it disappears for both of you, but moderators can still see it if the conversation is reported.</li>
        <li><strong>Connect:</strong> the name and contact you chose to share with a specific person, only after you both agreed.</li>
        <li><strong>Payments:</strong> handled by Stripe. We store that a payment happened and its amount, never your card.</li>
        <li><strong>Daily check-ins:</strong> the mood you log each day. Only you can see it; it's deleted immediately if you delete your account.</li>
        <li><strong>Notifications:</strong> if you turn them on, a push address for your device. Notifications never include message text.</li>
      </ul>
      <h2>How messages are checked</h2>
      <p>Every message is automatically screened before delivery to keep the community safe. The screening holds back contact details (until you both connect), questions about age, sexual content and messages suggesting a user is under 18. It also shows crisis resources when someone may be at risk. Trained moderators can read a conversation when it's reported or when a message is held.</p>
      <h2>Who sees what</h2>
      <p>The people you chat with see your anonymous name and your messages. Moderators see reported conversations and held messages. We don't sell your data. [List any analytics or ad partners here, and what they receive.]</p>
      <h2>Your choices</h2>
      <ul>
        <li>Download everything we hold about you from <em>Account → Download my data</em>.</li>
        <li>Delete your account from <em>Account → Delete account</em>. Your email, password, birthdate and anything you revealed are erased immediately. Messages and reports are kept for 90 days so moderators can finish any safety review, then permanently deleted.</li>
      </ul>
      <h2>Contact</h2>
      <p>[Company name, address, and privacy contact email.]</p>
    </>
  );
}

function Terms() {
  return (
    <>
      <h1 className="find-title">Terms</h1>
      <p className="draft">Draft: not yet reviewed by a lawyer.</p>
      <h2>Who can use Kindred</h2>
      <p>You must be 18 or older. Accounts that appear to belong to minors are paused and may be closed.</p>
      <h2>Kindred is peer support, not professional help</h2>
      <p>The people here are strangers, not counselors, doctors or emergency services. If you are in danger or thinking about ending your life, call or text <a href="tel:988">988</a> (US), contact local emergency services, or find a line at <a href="https://findahelpline.com" target="_blank" rel="noreferrer">findahelpline.com</a>.</p>
      <h2>How to behave</h2>
      <ul>
        <li>Be kind. No harassment, hate, threats, or sexual content.</li>
        <li>Don't ask for or share personal details unless you've both chosen to connect.</li>
        <li>Never ask anyone's age, and never talk with anyone you believe is under 18. Report them.</li>
        <li>No spam, scams, selling, or recruiting.</li>
      </ul>
      <p>We may hold messages, pause accounts while we review reports, and suspend accounts that break these rules.</p>
      <h2>Connect and payments</h2>
      <p>A connect request uses one credit. Nothing is revealed unless the other person accepts. If they decline, or you cancel before they answer, the credit returns to your account. [Refund policy for unused credits.]</p>
      <h2>The service</h2>
      <p>Kindred is provided as is. [Limitation of liability, dispute resolution, governing law, and how changes to these terms are announced.]</p>
    </>
  );
}

export default function Legal({ doc, onBack }) {
  return (
    <main className="screen legal">
      <button className="back" onClick={onBack}>← Back</button>
      {doc === 'privacy' ? <Privacy /> : <Terms />}
    </main>
  );
}
