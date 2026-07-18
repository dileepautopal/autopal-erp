export type LegalPagePath = '/privacy' | '/terms' | '/data-deletion'

type LegalBlock = {
  heading: string
  paragraphs: string[]
}

type LegalPageContent = {
  title: string
  blocks: LegalBlock[]
}

const legalPages: Record<LegalPagePath, LegalPageContent> = {
  '/privacy': {
    title: '1. Privacy Policy',
    blocks: [
      {
        heading: 'Effective Date: 17 July 2026',
        paragraphs: [],
      },
      {
        heading: 'Introduction',
        paragraphs: [
          'Welcome to AUTOPAL ERP, a digital business platform developed and operated by Autolite (India) Limited, Jaipur, Rajasthan, India. AUTOPAL ERP provides automotive aftermarket solutions including WhatsApp integration, ERP, QR authentication, warranty registration, dealer and distributor management, AI-enabled services and customer support.',
        ],
      },
      {
        heading: 'Information We Collect',
        paragraphs: [
          'We may collect names, company details, phone numbers, WhatsApp numbers, email addresses, GST/PAN where applicable, addresses, product enquiries, orders, PI information, QR and warranty data, WhatsApp messages, images and documents.',
        ],
      },
      {
        heading: 'How We Use Information',
        paragraphs: [
          'To process enquiries, generate Proforma Invoices, process orders, provide support, manage dealers/distributors, warranty, QR authentication, analytics, AI assistance and fraud prevention.',
        ],
      },
      {
        heading: 'WhatsApp Integration',
        paragraphs: [
          'Messages sent to our official WhatsApp Business account may be processed automatically for enquiries, order booking, PI generation and customer support.',
        ],
      },
      {
        heading: 'Data Sharing',
        paragraphs: [
          'Information may be shared only with authorised employees, authorised partners, cloud hosting providers and government authorities where legally required. We do not sell customer personal information.',
        ],
      },
      {
        heading: 'Data Security',
        paragraphs: [
          'Industry-standard security measures including authentication, backups and access controls are used.',
        ],
      },
      {
        heading: 'User Rights',
        paragraphs: [
          'Users may request access, correction or deletion of eligible personal information.',
        ],
      },
      {
        heading: 'Contact',
        paragraphs: [
          'Autolite (India) Limited\nERP Division\nJaipur, Rajasthan, India\nEmail: info@autopal.com\nWebsite: https://autopal.com',
        ],
      },
    ],
  },
  '/terms': {
    title: '2. Terms & Conditions',
    blocks: [
      {
        heading: 'Acceptance',
        paragraphs: ['By using AUTOPAL ERP you agree to these Terms & Conditions.'],
      },
      {
        heading: 'Services',
        paragraphs: [
          'Product information, ERP services, WhatsApp integration, QR authentication, warranty registration, PI generation, AI services and related business functions.',
        ],
      },
      {
        heading: 'User Responsibilities',
        paragraphs: [
          'Provide accurate information, avoid misuse, do not upload illegal content and do not attempt unauthorised access.',
        ],
      },
      {
        heading: 'Orders',
        paragraphs: [
          'Orders and PI requests are subject to commercial approval and product availability.',
        ],
      },
      {
        heading: 'Pricing',
        paragraphs: ['Prices, taxes and freight are subject to change.'],
      },
      {
        heading: 'Intellectual Property',
        paragraphs: [
          'All software, trademarks and content remain the property of Autolite (India) Limited.',
        ],
      },
      {
        heading: 'Limitation of Liability',
        paragraphs: ["Services are provided on an 'as available' basis."],
      },
      {
        heading: 'Governing Law',
        paragraphs: [
          'Governed by the laws of India. Jurisdiction: Jaipur, Rajasthan.',
        ],
      },
    ],
  },
  '/data-deletion': {
    title: '3. Data Deletion Policy',
    blocks: [
      {
        heading: 'Purpose',
        paragraphs: [
          'AUTOPAL ERP respects requests for deletion of eligible personal information.',
        ],
      },
      {
        heading: 'Information Eligible',
        paragraphs: [
          'Personal profile, contact information, customer profile, dealer profile, technician profile and WhatsApp conversation records where legally permissible.',
        ],
      },
      {
        heading: 'Information That May Be Retained',
        paragraphs: [
          'Records required for taxation, accounting, warranty, legal compliance and audit.',
        ],
      },
      {
        heading: 'How to Request',
        paragraphs: [
          'Email info@autopal.com with your name, mobile number, email and reason for deletion.',
        ],
      },
      {
        heading: 'Processing Time',
        paragraphs: [
          'Requests are generally processed within 30 business days after identity verification.',
        ],
      },
      {
        heading: 'Third-Party Services',
        paragraphs: [
          'Some information may also exist with Meta Platforms, cloud hosting providers and payment providers, governed by their own policies.',
        ],
      },
      {
        heading: 'Contact',
        paragraphs: [
          'Autolite (India) Limited\nERP Division\nJaipur, Rajasthan\nEmail: info@autopal.com',
        ],
      },
    ],
  },
}

export const isLegalPagePath = (path: string): path is LegalPagePath =>
  path === '/privacy' || path === '/terms' || path === '/data-deletion'

const legalNavigation: Array<{ href: LegalPagePath | '/'; label: string }> = [
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms', label: 'Terms & Conditions' },
  { href: '/data-deletion', label: 'Data Deletion' },
  { href: '/', label: 'Back to Login' },
]

type LegalPageProps = {
  path: LegalPagePath
}

export function LegalPage({ path }: LegalPageProps) {
  const page = legalPages[path]

  return (
    <main className="legal-page">
      <section className="legal-shell" aria-labelledby="legal-page-title">
        <header className="legal-header">
          <div className="legal-brand-row">
            <img
              alt="AUTOPAL logo"
              className="legal-logo"
              src="/autopal-logo.png"
            />
            <div>
              <p className="eyebrow">AUTOPAL ERP</p>
              <strong className="legal-company-name">
                Autolite (India) Limited
              </strong>
              <h1 id="legal-page-title">{page.title}</h1>
            </div>
          </div>
          <nav aria-label="Legal pages" className="legal-nav">
            {legalNavigation.map((item) => (
              <a
                aria-current={item.href === path ? 'page' : undefined}
                href={item.href}
                key={item.href}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </header>

        <article className="legal-card">
          {page.blocks.map((block) => (
            <section className="legal-section" key={block.heading}>
              <h2>{block.heading}</h2>
              {block.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </section>
          ))}
        </article>

        <footer className="legal-footer">
          <strong>© 2026 Autolite (India) Limited</strong>
          <span>Jaipur, Rajasthan, India</span>
          <a href="mailto:info@autopal.com">info@autopal.com</a>
        </footer>
      </section>
    </main>
  )
}

export function PublicNotFoundPage() {
  return (
    <main className="legal-page">
      <section className="legal-shell" aria-labelledby="not-found-title">
        <header className="legal-header">
          <div className="legal-brand-row">
            <img
              alt="AUTOPAL logo"
              className="legal-logo"
              src="/autopal-logo.png"
            />
            <div>
              <p className="eyebrow">AUTOPAL ERP</p>
              <strong className="legal-company-name">
                Autolite (India) Limited
              </strong>
              <h1 id="not-found-title">Page Not Found</h1>
            </div>
          </div>
        </header>

        <article className="legal-card not-found-card">
          <section className="legal-section">
            <h2>404</h2>
            <p>The page you requested is not available.</p>
          </section>
          <a className="return-login-button" href="/">
            Return to Login
          </a>
        </article>

        <footer className="legal-footer">
          <strong>© 2026 Autolite (India) Limited</strong>
          <span>Jaipur, Rajasthan, India</span>
          <a href="mailto:info@autopal.com">info@autopal.com</a>
        </footer>
      </section>
    </main>
  )
}
