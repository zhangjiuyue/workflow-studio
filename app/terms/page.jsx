import { LegalDocument } from "../legal-documents";

export const metadata = {
  title: "User Agreement (Terms of Service) - Workflow Studio",
  description: "Workflow Studio User Agreement (Terms of Service)",
};

export default function TermsPage() {
  return (
    <main className="legal-page">
      <LegalDocument type="terms" />
    </main>
  );
}
