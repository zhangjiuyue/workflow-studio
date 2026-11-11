import { LegalDocument } from "../legal-documents";

export const metadata = {
  title: "Privacy Policy - Workflow Studio",
  description: "Workflow Studio Privacy Policy",
};

export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <LegalDocument type="privacy" />
    </main>
  );
}
