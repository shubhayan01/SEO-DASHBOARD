// profiles.js — per-site "realistic data" profiles for the synthetic ("live")
// sync (see sync.js Phase C + mock.js generateDashboard opts.profile).
//
// These do NOT fabricate a claim about real traffic — they just make the
// synthetic figures look plausible FOR THAT SPECIFIC SITE: the right niche
// keywords, the site's real page URLs, India-weighted geography, a sensible
// Google Business Profile category/locale, and realistic magnitude anchors.
// Built from a look at each live site (Oct 2026). Keyed by hostname.

const host = (u) => {
  try { return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).host.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
};

// Shared bits for the Justwords content-marketing brand.
const JW_KEYWORDS = [
  'content marketing agency india', 'content writing services', 'seo agency india',
  'content marketing company', 'b2b content writing services', 'blog writing services india',
  'content strategy agency', 'seo content writing', 'guest posting services',
  'technical seo services', 'local seo services india', 'social media marketing agency',
  'website content writing', 'generative engine optimization services', 'ai seo services',
  'ecommerce seo services', 'copywriting services india', 'product description writing',
  'content marketing for saas', 'link building services india',
];
const JW_PAGES = [
  { path: '/', label: 'Home' },
  { path: '/content/content-writing-services/', label: 'Content Writing Services' },
  { path: '/content/content-marketing-services/', label: 'Content Marketing Services' },
  { path: '/digital-strategy/seo-services/', label: 'SEO Services' },
  { path: '/content/content-strategy/', label: 'Content Strategy' },
  { path: '/digital-strategy/social-media-marketing-services/', label: 'Social Media Marketing' },
  { path: '/digital-strategy/website-development-company/', label: 'Website Development' },
  { path: '/all-work/', label: 'Case Studies' },
  { path: '/blog/', label: 'Blog' },
  { path: '/about/', label: 'About' },
  { path: '/contact-us/', label: 'Contact' },
];
const JW_COMPETITORS = ['peppercontent.io', 'contentwhale.com', 'textuar.com', 'writeright.in'];
const JW_REFERRING = ['yourstory.com', 'inc42.com', 'business-standard.com',
  'economictimes.indiatimes.com', 'g2.com', 'clutch.co', 'medium.com', 'hubspot.com'];
const JW_REVIEW_AUTHORS = ['A. Sharma', 'R. Iyer', 'P. Nair', 'S. Gupta', 'M. Reddy',
  'K. Menon', 'N. Kapoor', 'V. Desai'];
// India-heavy, with the overseas markets the site says it serves.
const JW_COUNTRIES = [
  ['India', 60], ['United States', 14], ['United Kingdom', 8],
  ['United Arab Emirates', 6], ['Canada', 4], ['Singapore', 4], ['Australia', 4],
];

const PROFILES = {
  'justwords.in': {
    brand: 'Justwords',
    trafficBase: 14200, keywordsBase: 3400, daBase: 44, avgPos: [7, 18],
    keywords: JW_KEYWORDS,
    pages: JW_PAGES,
    competitors: JW_COMPETITORS,
    referringDomains: JW_REFERRING,
    reviewAuthors: JW_REVIEW_AUTHORS,
    countries: JW_COUNTRIES,
    gbp: { category: 'Content Marketing Agency', phoneCc: '+91', city: 'Gurugram', street: 'Sohna Road' },
  },
  // Same brand, smaller secondary property (the domain is not a large live
  // site), so scaled down but same niche.
  'justwords.digital': {
    brand: 'Justwords',
    trafficBase: 2600, keywordsBase: 760, daBase: 23, avgPos: [10, 24],
    keywords: JW_KEYWORDS,
    pages: [
      { path: '/', label: 'Home' },
      { path: '/content-marketing/', label: 'Content Marketing' },
      { path: '/seo/', label: 'SEO' },
      { path: '/services/', label: 'Services' },
      { path: '/blog/', label: 'Blog' },
      { path: '/about/', label: 'About' },
      { path: '/contact/', label: 'Contact' },
    ],
    competitors: JW_COMPETITORS,
    referringDomains: JW_REFERRING,
    reviewAuthors: JW_REVIEW_AUTHORS,
    countries: JW_COUNTRIES,
    gbp: { category: 'Content Marketing Agency', phoneCc: '+91', city: 'Bengaluru', street: 'Koramangala' },
  },
  'maxifygrowth.com': {
    brand: 'MaxifyGrowth',
    trafficBase: 3200, keywordsBase: 640, daBase: 27, avgPos: [8, 22],
    keywords: [
      'business consulting services', 'business growth consultant', 'strategic business consulting',
      'sales training programs', 'sales negotiation training', 'key account management training',
      'sales leadership training', 'msme business consulting', 'go to market strategy consultant',
      'business coaching for entrepreneurs', 'sales performance improvement', 'value based selling training',
      'market expansion strategy', 'business process consulting', 'revenue growth consulting',
      'corporate sales training india', 'soft skills training programs', 'leadership development program',
      'profitability consulting', 'business turnaround consultant',
    ],
    pages: [
      { path: '/', label: 'Home' },
      { path: '/strategic-business-consulting-services/', label: 'Business Consulting' },
      { path: '/value-based-sales-training/', label: 'Value-Based Selling' },
      { path: '/key-account-management-training/', label: 'Key Account Management' },
      { path: '/sales-negotiation-skills-training/', label: 'Negotiation Masterclass' },
      { path: '/sales-leadership-training-program/', label: 'Sales Leadership' },
      { path: '/soft-skills-training-program/', label: 'Soft Skills Training' },
      { path: '/about-us/', label: 'About Us' },
      { path: '/blog/', label: 'Blog' },
      { path: '/resources/', label: 'Resources' },
      { path: '/contact-us/', label: 'Contact' },
    ],
    competitors: ['yatharthmarketing.com', 'dalecarnegie.in', 'salesgurukul.com', 'growthschool.io'],
    referringDomains: ['economictimes.indiatimes.com', 'yourstory.com', 'linkedin.com',
      'startupindia.gov.in', 'business-standard.com', 'medium.com', 'clutch.co', 'justdial.com'],
    reviewAuthors: ['R. Mehta', 'S. Agarwal', 'A. Khanna', 'V. Rao', 'D. Joshi', 'P. Bhatt', 'M. Shah', 'K. Pillai'],
    countries: [
      ['India', 78], ['United States', 8], ['United Arab Emirates', 5],
      ['United Kingdom', 4], ['Singapore', 3], ['Canada', 2],
    ],
    gbp: { category: 'Business Management Consultant', phoneCc: '+91', city: 'Pune', street: 'Baner Road' },
  },
};

/** Return the realistic-data profile for a site URL, or null if none is defined. */
export function profileFor(url) {
  return PROFILES[host(url)] || null;
}
