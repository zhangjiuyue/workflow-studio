export const LEGAL_DOCUMENT_META = {
  terms: {
    dialogTitle: "User Agreement",
  },
  privacy: {
    dialogTitle: "Privacy Policy",
  },
};

export function LegalDocument({ type, embedded = false }) {
  if (type === "privacy") return <PrivacyDocument embedded={embedded} />;
  return <TermsDocument embedded={embedded} />;
}

function legalDocumentClassName(embedded) {
  return embedded ? "legal-document legal-document-embedded" : "legal-document";
}

function TermsDocument({ embedded }) {
  return (
    <article className={legalDocumentClassName(embedded)}>
      <header className="legal-header">
        <p>Workflow Studio</p>
        <h1>User Agreement (Terms of Service)</h1>
        <span>Effective Date: June 1, 2026</span>
      </header>

      <p>
        This User Agreement (the "Terms") applies to your access to and use of Workflow Studio, including our website,
        workflow tools, AI-assisted creation features, asset management, API Key management, team collaboration
        features, and related services (collectively, the "Service").
      </p>
      <p>
        By registering for an account, accessing, or using the Service, you confirm that you have read, understood,
        and agree to be bound by these Terms. If you do not agree to these Terms, do not use the Service.
      </p>

      <section>
        <h2>1. Who We Are</h2>
        <p>
          Workflow Studio is a workflow tool for AI-assisted content creation. In these Terms, "Workflow Studio," "we," "us,"
          and "our" refer to the operator of the Workflow Studio website and related services.
        </p>
        <p>Contact email: operator@example.invalid</p>
        <p>Website: https://example.invalid</p>
      </section>

      <section>
        <h2>2. Eligibility and Account Access</h2>
        <p>
          You must be at least 18 years old, or the age of legal majority in your jurisdiction, to use the Service.
          The Service is not intended for children.
        </p>
        <p>
          If you use the Service on behalf of a company, team, organization, studio, or other entity, you confirm
          that you have authority to accept these Terms on that entity's behalf and bind that entity to these Terms.
        </p>
        <p>
          You must provide truthful, accurate, and complete account information, keep your login credentials secure,
          and notify us promptly if you discover account theft, unusual login activity, or unauthorized access. You
          may not sell, rent, transfer, or share your account with unrelated third parties.
        </p>
      </section>

      <section>
        <h2>3. Private Beta, Approval, and Access Rights</h2>
        <p>
          Workflow Studio may be offered as a private beta, invitation-only service, approval-based service, or membership
          service. Submitting a registration request does not guarantee access.
        </p>
        <p>
          For security, risk control, payment status, system stability, compliance, or product testing reasons, we
          may approve, reject, suspend, limit, or terminate your access.
        </p>
        <p>
          Service features, quotas, workflows, supported models, pricing, usage limits, and availability may change
          as the product evolves.
        </p>
      </section>

      <section>
        <h2>4. Service Description</h2>
        <p>
          Workflow Studio provides workflow orchestration and productivity tools for AI-assisted content creation. Depending
          on your access level, the Service may include text, image, audio, video, asset library, team workspace, API
          configuration, and automation features.
        </p>
        <p>
          Workflow Studio is a workflow and interface-layer tool. We do not own or control all third-party AI models, cloud
          services, storage services, payment services, or external APIs.
        </p>
      </section>

      <section>
        <h2>5. Third-Party AI Services and User API Keys</h2>
        <p>
          The Service may allow you to connect third-party API Keys or use third-party services through supported
          integrations. When you connect an API Key or choose a third-party provider, you authorize Workflow Studio to
          transmit prompts, input content, files, parameter settings, and related request data to that provider on
          your behalf.
        </p>
        <p>
          You are responsible for ensuring that your API Keys are lawfully obtained, valid, sufficiently funded, and
          permitted for your intended use. You are responsible for third-party service fees, rate limits, account
          restrictions, model changes, content moderation, output limitations, and other third-party service risks.
        </p>
        <p>
          Third-party services are governed by their own terms and policies. Workflow Studio is not responsible for
          third-party service failures, delays, errors, account restrictions, price changes, or output quality.
        </p>
      </section>

      <section>
        <h2>6. User Content</h2>
        <p>
          "User Content" means text, prompts, images, audio, video, files, data, API configurations, workflow settings,
          assets, and other materials that you upload, submit, import, generate, save, or share through the Service.
        </p>
        <p>
          You retain the rights you lawfully hold in your User Content. You grant Workflow Studio a limited, worldwide,
          non-exclusive, royalty-free license to host, store, process, transmit, display, reproduce, modify, and use
          your User Content as reasonably necessary to provide, maintain, secure, troubleshoot, improve, and support
          the Service.
        </p>
        <p>
          You represent and warrant that you have all rights, licenses, authorizations, and consents required to use
          and upload User Content, including rights related to copyrighted works, trademarks, likenesses, voices,
          biometric information, confidential information, or third-party materials.
        </p>
      </section>

      <section>
        <h2>7. AI-Generated Outputs</h2>
        <p>
          The Service may generate or help generate text, images, audio, video, prompts, scripts, storyboards, or
          other outputs ("Generated Outputs").
        </p>
        <p>
          You should review Generated Outputs before publishing, selling, distributing, advertising, or otherwise
          using them. AI-generated outputs may be inaccurate, incomplete, offensive, biased, infringing, unsuitable
          for commercial use, or inconsistent with your expectations.
        </p>
        <p>
          Workflow Studio does not guarantee that Generated Outputs are unique, copyrightable, free of third-party rights,
          factually accurate, legally compliant, or suitable for any specific purpose.
        </p>
      </section>

      <section>
        <h2>8. Synthetic Media and Disclosure Labels</h2>
        <p>
          You are responsible for complying with laws, regulations, platform rules, advertising policies, and
          disclosure requirements that apply to AI-generated content or synthetic media.
        </p>
        <p>
          You may not use the Service to create, edit, publish, or distribute deceptive synthetic media,
          impersonation content, false endorsements, likeness or voice content without consent, deepfake fraud,
          misleading political content, forged official information, or AI-generated content falsely presented as
          real footage, real audio, or real evidence.
        </p>
        <p>
          We may add, retain, or require visible or invisible labels, watermarks, metadata, or other identifiers for
          AI-generated or synthetic content. Where applicable law, platform policy, or these Terms require such
          identifiers to remain in place, you may not remove, obscure, or use them in a misleading way.
        </p>
      </section>

      <section>
        <h2>9. Team Workspaces and Shared Assets</h2>
        <p>
          If you use team features, team owners or administrators may manage members, shared assets, shared API Keys,
          workflows, permissions, review status, and access controls.
        </p>
        <p>
          When you share content, API configurations, or assets with a team, you authorize Workflow Studio to provide access
          to authorized team members according to team settings. If you leave a team or are removed from a team, your
          access to team resources may be limited or terminated.
        </p>
        <p>
          You are responsible for permission management, client authorizations, confidentiality obligations, and
          rights clearance within your organization or team.
        </p>
      </section>

      <section>
        <h2>10. Fees, Subscriptions, Quotas, and Refunds</h2>
        <p>
          Some Service features may require payment, membership, usage quotas, or a written commercial arrangement.
        </p>
        <p>
          You agree to pay the amounts shown on the order page, invoice, written agreement, or otherwise confirmed by
          Workflow Studio. Fees may vary by access level, usage, support level, third-party costs, team size, or feature
          scope.
        </p>
        <p>
          Unless required by law or agreed in writing, used services, consumed quotas, enabled configurations,
          completed support work, and incurred third-party API or infrastructure costs are generally non-refundable.
        </p>
        <p>
          If payment fails, a chargeback occurs, a transaction is reversed, or we cannot confirm receipt of payment,
          we may suspend or limit the relevant paid features.
        </p>
      </section>

      <section>
        <h2>11. Acceptable Use</h2>
        <p>You may not use the Service to:</p>
        <ul>
          <li>Violate any law, regulation, third-party right, platform rule, or contractual obligation.</li>
          <li>Create, upload, or distribute unlawful, harmful, abusive, harassing, defamatory, fraudulent, misleading, or infringing content.</li>
          <li>Infringe copyrights, trademarks, likeness rights, privacy rights, trade secrets, or confidential information.</li>
          <li>Generate non-consensual sexual content, exploitative content involving minors, or content that sexualizes minors.</li>
          <li>Create malware, phishing, scams, spam, credential theft, evasion tools, or unauthorized system access.</li>
          <li>Create deceptive deepfakes, false official documents, forged evidence, impersonation content, or false endorsements.</li>
          <li>Mislead others about the source, authenticity, sponsorship, or AI-generated nature of content.</li>
          <li>Scrape, load test, reverse engineer, probe, attack, bypass limits, or interfere with the Service.</li>
          <li>Resell, sublicense, or provide access to the Service to others without authorization.</li>
          <li>Use the Service in high-risk contexts that could result in death, personal injury, major property damage, legal harm, or other substantial risks.</li>
        </ul>
      </section>

      <section>
        <h2>12. Suspension and Termination</h2>
        <p>
          If we believe you have violated these Terms, created legal or security risk, failed to pay fees, abused the
          Service, infringed third-party rights, or caused harm to Workflow Studio, users, service providers, or the public,
          we may suspend, limit, or terminate your access.
        </p>
        <p>
          To comply with law, enforce these Terms, protect rights, prevent abuse, or maintain service stability, we
          may delete, restrict, or block relevant content.
        </p>
        <p>
          You may stop using the Service at any time. Terms concerning intellectual property, payment obligations,
          disclaimers, limitations of liability, and indemnification will survive termination of the Service.
        </p>
      </section>

      <section>
        <h2>13. Intellectual Property</h2>
        <p>
          Workflow Studio and its licensors retain all rights in the Service, including software, interface design,
          workflows, documentation, brands, marks, systems, and underlying technology.
        </p>
        <p>
          Unless permitted by law or expressly authorized by us, you may not copy, modify, distribute, sell, rent,
          reverse engineer, or create derivative works based on the Service.
        </p>
      </section>

      <section>
        <h2>14. Copyright Complaints</h2>
        <p>
          If you believe content in the Service infringes your copyright, contact us at operator@example.invalid and
          provide information sufficient to identify the copyrighted work, the allegedly infringing content, your
          contact information, and a statement that you have a good-faith belief that the use is unauthorized.
        </p>
        <p>
          We may remove or restrict allegedly infringing content and, where appropriate, terminate accounts of repeat
          infringers.
        </p>
      </section>

      <section>
        <h2>15. Privacy and Data</h2>
        <p>
          How we collect and use personal data is described in our Privacy Policy. By using the Service, you
          acknowledge that we may process account information, uploaded files, prompts, generated results, workflow
          data, API configuration metadata, payment information, usage logs, device information, and customer support
          communications in accordance with the Privacy Policy.
        </p>
        <p>
          You must ensure that any personal data you upload or process through the Service is lawfully sourced and
          that you have provided any required notices and obtained any required consents.
        </p>
      </section>

      <section>
        <h2>16. Service Availability</h2>
        <p>
          The Service is provided on an "as is" and "as available" basis. We do not guarantee that the Service will
          always be uninterrupted, error-free, permanently stored, that models will always be available, that generated
          results will meet specific requirements, or that the Service will be compatible with all third-party
          services.
        </p>
        <p>
          The Service may be temporarily unavailable due to maintenance, upgrades, failures, third-party service
          issues, security issues, capacity limits, legal requirements, or force majeure events.
        </p>
      </section>

      <section>
        <h2>17. Disclaimers</h2>
        <p>
          To the maximum extent permitted by applicable law, Workflow Studio makes no express or implied warranties,
          including warranties of merchantability, fitness for a particular purpose, title, non-infringement,
          accuracy, availability, or reliability.
        </p>
        <p>You are responsible for determining whether the Service and any Generated Outputs are suitable for your intended use.</p>
      </section>

      <section>
        <h2>18. Limitation of Liability</h2>
        <p>
          To the maximum extent permitted by applicable law, Workflow Studio is not liable for any indirect, incidental,
          special, consequential, punitive, or exemplary damages, including lost profits, lost revenue, data loss,
          business interruption, loss of goodwill, third-party service issues, or content-related claims.
        </p>
        <p>
          To the maximum extent permitted by applicable law, Workflow Studio's total cumulative liability arising from or
          related to the Service will not exceed the service fees you actually paid to Workflow Studio during the three
          months before the event giving rise to the claim; if you paid no fees, liability will not exceed US$100.
        </p>
      </section>

      <section>
        <h2>19. Indemnification</h2>
        <p>
          You agree to defend, indemnify, and hold harmless Workflow Studio and its operators, affiliates, employees,
          contractors, service providers, and licensors from any claims, damages, liabilities, losses, costs, and
          expenses arising from your User Content, Generated Outputs, use of the Service, violation of these Terms,
          violation of law, or infringement of third-party rights.
        </p>
      </section>

      <section>
        <h2>20. Changes to These Terms</h2>
        <p>
          We may update these Terms from time to time. If changes are material, we will take reasonable steps to
          notify you, such as posting an updated version on the website, providing an in-product notice, or sending an
          email.
        </p>
        <p>
          After updated Terms become effective, your continued use of the Service means you accept the updated Terms.
        </p>
      </section>

      <section>
        <h2>21. Contact</h2>
        <p>If you have any questions about these Terms, please contact us at:</p>
        <p>Email: operator@example.invalid</p>
      </section>
    </article>
  );
}

function PrivacyDocument({ embedded }) {
  return (
    <article className={legalDocumentClassName(embedded)}>
      <header className="legal-header">
        <p>Workflow Studio</p>
        <h1>Privacy Policy</h1>
        <span>Effective Date: June 1, 2026</span>
      </header>

      <p>
        This Privacy Policy explains how Workflow Studio ("Workflow Studio," "we," "us," and "our") collects, uses, stores,
        shares, and protects information when you access or use our website, workflow tools, AI-assisted creation
        features, asset management, API Key management, team collaboration features, and related services
        (collectively, the "Service").
      </p>
      <p>By using the Service, you acknowledge that we will process relevant information in accordance with this Privacy Policy.</p>

      <section>
        <h2>1. Information We Collect</h2>
        <p>We may collect the following types of information:</p>
        <p><strong>Account information:</strong> Email address, display name, password credentials, account status, approval status, membership status, team role, and related account settings.</p>
        <p><strong>User Content:</strong> Prompts, text, images, audio, video, files, workflow configurations, creative assets, generated results, uploaded reference materials, and other content you submit, upload, generate, save, or share through the Service.</p>
        <p><strong>API configuration information:</strong> Third-party API Key settings, provider names, endpoint addresses, model selections, service types, and related metadata. API Keys may be stored in encrypted form and, where supported, displayed only in masked form.</p>
        <p><strong>Usage and log information:</strong> Pages visited, features used, workflow runs, generation tasks, request status, timestamps, error logs, performance data, provider/model metadata, request summaries, and usage records.</p>
        <p><strong>Device and technical information:</strong> IP address, browser type, operating system, device identifiers, language settings, referrer pages, and similar technical data.</p>
        <p><strong>Payment and subscription information:</strong> If we offer paid features, we may collect subscription status, plan information, payment confirmation, invoice metadata, and related transaction records. Card, wallet, and other payment details may be processed by third-party payment providers.</p>
        <p><strong>Communications:</strong> Messages, support requests, feedback, emails, and other communications you send to us.</p>
      </section>

      <section>
        <h2>2. How We Use Information</h2>
        <p>We use information to:</p>
        <ul>
          <li>Provide, operate, maintain, and improve the Service.</li>
          <li>Create and manage accounts, approvals, memberships, sessions, and team access rights.</li>
          <li>Process workflows, AI generation tasks, uploaded files, creative assets, and generated results.</li>
          <li>Store and manage user-configured API Keys and call third-party services on your behalf at your request.</li>
          <li>Monitor usage, enforce quota limits, troubleshoot errors, and maintain service stability.</li>
          <li>Prevent fraud, abuse, unauthorized access, spam, and security risks.</li>
          <li>Respond to support requests, user inquiries, copyright complaints, and legal requests.</li>
          <li>Send service-related notices, updates, security alerts, and administrative messages.</li>
          <li>Analyze and improve product features, reliability, and user experience.</li>
          <li>Comply with legal obligations and enforce our Terms of Service.</li>
        </ul>
        <p>Unless we obtain your explicit consent, we will not use your private User Content to train our own AI models.</p>
      </section>

      <section>
        <h2>3. AI Processing and Third-Party Providers</h2>
        <p>
          Workflow Studio is a workflow and interface-layer tool. When you use AI-related features, your prompts, files,
          parameter settings, and related request data may be sent to third-party AI providers, infrastructure
          providers, storage providers, or other external services selected or configured through the Service.
        </p>
        <p>
          These third-party services may process your information according to their own terms, privacy policies, data
          retention rules, and security measures. We cannot control all third-party processing activities, model
          behavior, content moderation decisions, service availability, or data retention practices.
        </p>
        <p>
          If you connect your own third-party API Key, you authorize Workflow Studio to use that API Key to submit requests
          to the relevant provider on your behalf.
        </p>
      </section>

      <section>
        <h2>4. User API Keys</h2>
        <p>
          If you save an API Key in the Service, we will use it only to provide the features you request, such as
          calling third-party AI, audio, image, video, storage, or workflow services.
        </p>
        <p>
          Where supported, API Keys are stored in encrypted form and displayed in the user interface only in masked
          form. We do not intentionally disclose your full API Key to other users. Team-shared API Keys may be usable
          by authorized team members according to team settings, but where supported, the full key value can remain
          hidden.
        </p>
        <p>
          You are responsible for the legality, security, usage limits, billing, and third-party account status of any
          API Keys you connect.
        </p>
      </section>

      <section>
        <h2>5. How We Share Information</h2>
        <p>We may share information in the following circumstances:</p>
        <p><strong>Service providers:</strong> With vendors that help us host, store, secure, process, analyze, support, or operate the Service.</p>
        <p><strong>Third-party AI and API providers:</strong> As necessary to process your workflows, prompts, uploaded content, generated content, or API requests.</p>
        <p><strong>Team workspaces:</strong> With team owners, administrators, or authorized members when you join a team, share assets, use team resources, or submit content for team review.</p>
        <p><strong>Legal and safety reasons:</strong> When required by law, legal process, or government request, or when necessary to protect rights, safety, users, service providers, or the public interest.</p>
        <p><strong>Business transfers:</strong> If the Service is involved in a merger, acquisition, financing, restructuring, or asset transfer, information may be transferred as part of that transaction.</p>
        <p><strong>With your consent:</strong> When you direct us to share information or otherwise provide consent.</p>
        <p>
          We do not "sell" your personal information in the ordinary sense. Unless we update this Privacy Policy and
          provide choices required by law, we also do not share personal information for cross-context behavioral
          advertising purposes.
        </p>
      </section>

      <section>
        <h2>6. Cookies and Local Storage</h2>
        <p>
          We may use cookies, local storage, session storage, and similar technologies to keep you signed in, remember
          preferences, maintain security, and improve the Service.
        </p>
        <p>
          For example, the Service may save authentication tokens, session information, user identifiers, interface
          preferences, or draft settings in your browser.
        </p>
        <p>
          If we use analytics, advertising, or tracking technologies in the future that require additional consent in
          certain regions, we will update this Privacy Policy and provide choices where required by law.
        </p>
      </section>

      <section>
        <h2>7. Data Retention</h2>
        <p>
          We retain information for as long as reasonably necessary to provide the Service, maintain accounts, support
          workflows, comply with legal obligations, resolve disputes, enforce agreements, prevent abuse, and keep
          business records.
        </p>
        <p>
          Uploaded files, generated results, workflow data, API configuration metadata, usage records, and logs may be
          retained while your account is active or for the period needed for the purposes described above.
        </p>
        <p>
          Certain run logs may be retained for a limited period for security, troubleshooting, abuse prevention, and
          reliability maintenance. When information is no longer needed, we may delete, anonymize, or aggregate it.
        </p>
      </section>

      <section>
        <h2>8. Data Security</h2>
        <p>
          We use reasonable technical and organizational measures to protect information, including access controls,
          appropriate encryption, secure transmission, credential protection, and limits on access to sensitive
          systems.
        </p>
        <p>
          However, no internet transmission or storage system can be guaranteed to be completely secure. You are also
          responsible for protecting your own account credentials and third-party API Keys.
        </p>
      </section>

      <section>
        <h2>9. International Data Transfers</h2>
        <p>
          Because the Service may be available to users worldwide and may rely on third-party providers located in
          different countries or regions, your information may be processed, stored, or transferred outside your
          country or region.
        </p>
        <p>
          Where required by law, we will take reasonable steps to protect transferred information in a manner
          consistent with applicable data protection laws.
        </p>
      </section>

      <section>
        <h2>10. Your Privacy Rights</h2>
        <p>Depending on where you are located, you may have the following rights:</p>
        <ul>
          <li>Request access to personal information we hold about you.</li>
          <li>Request correction of inaccurate or incomplete information.</li>
          <li>Request deletion of certain personal information.</li>
          <li>Request a copy of certain information in a portable format.</li>
          <li>Object to or restrict certain processing activities.</li>
          <li>Withdraw consent where processing is based on consent.</li>
          <li>Opt out of marketing communications.</li>
        </ul>
        <p>
          To exercise privacy rights, contact us at operator@example.invalid. We may need to verify your identity first.
        </p>
      </section>

      <section>
        <h2>11. California Privacy Rights</h2>
        <p>
          If you are a California resident, you may have rights under California privacy laws, including rights to
          know, access, correct, delete, and opt out of certain sharing or sale of personal information.
        </p>
        <p>
          We do not sell personal information. If our practices change, we will update this Privacy Policy and provide
          notices and choices required by law.
        </p>
      </section>

      <section>
        <h2>12. EEA and UK Privacy Rights</h2>
        <p>
          If you are located in the European Economic Area, the United Kingdom, or another region with similar data
          protection laws, you may have additional rights under applicable law.
        </p>
        <p>
          Our legal bases for processing information may include performance of a contract, legitimate interests,
          consent, compliance with legal obligations, and protection of rights and safety.
        </p>
        <p>You may also have the right to complain to your local data protection authority.</p>
      </section>

      <section>
        <h2>13. Children's Privacy</h2>
        <p>
          The Service is not intended for children under 18. We do not knowingly collect personal information from
          children. If you believe a child has provided personal information to us, contact us at
          operator@example.invalid, and we will take appropriate steps.
        </p>
      </section>

      <section>
        <h2>14. User Content Privacy</h2>
        <p>
          Your workflows, prompts, uploaded files, assets, and generated results are generally treated as private
          content within your account or team workspace.
        </p>
        <p>
          We will not publicly publish your private User Content without your permission. However, we may access,
          process, or review relevant User Content when necessary to provide the Service, troubleshoot issues,
          maintain security, investigate abuse, respond to support requests, enforce the Terms of Service, comply
          with law, or handle rights complaints.
        </p>
      </section>

      <section>
        <h2>15. Changes to This Privacy Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. If changes are material, we will take reasonable steps
          to notify you, such as posting an updated version on the website, providing an in-product notice, or sending
          an email.
        </p>
        <p>
          After the updated Privacy Policy becomes effective, your continued use of the Service means you acknowledge
          the updated policy.
        </p>
      </section>

      <section>
        <h2>16. Contact</h2>
        <p>If you have any questions or requests about this Privacy Policy or our data processing practices, please contact us at:</p>
        <p>Email: operator@example.invalid</p>
      </section>
    </article>
  );
}
