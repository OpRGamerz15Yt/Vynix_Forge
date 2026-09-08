// Centralized plan configuration. Every part of the backend that needs to
// know what a plan can do reads from here -- nothing about limits should
// ever be hardcoded elsewhere (routes, middleware, admin tools all import
// this module).

// Prices are configured, fixed price points per currency -- NOT computed
// from a live/hardcoded exchange rate. This is standard practice (the same
// reason software is "$9.99" in the US and a clean round local number
// elsewhere, rather than a literal FX conversion that drifts daily and
// produces ugly numbers). If you want BDT to track FX movements over time,
// that's a deliberate separate decision -- update these numbers directly,
// don't bolt a live-rate multiplier onto them.
const CURRENCY_SYMBOLS = { USD: '$', BDT: '\u09f3' };
const SUPPORTED_CURRENCIES = ['USD', 'BDT'];

const PLANS = {
  free: {
    id: 'free',
    label: 'Free',
    prices: { USD: 0, BDT: 0 },
    maxActiveProjects: 1,
    sourceExport: true,     // download the generated source folder
    cloudBuild: false,      // Vynix-run build via GitHub Actions
    productionExe: false,   // Dev-tier "production" Windows build
    apiAccess: false,
    webhooks: false,
    buildAutomation: false,
    priorityQueue: false,
    privateProjects: false,
    launcherHosting: false,
    storageMb: 0,
    maxBuildsPerDay: 3,       // still rate-limited even for the free "generate source" action
    purchasable: true,
    stripePriceIds: { USD: null, BDT: null } // free -- never actually charged
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    prices: { USD: 4.99, BDT: 500 },
    maxActiveProjects: 10,          // "configurable" per spec -- this is the current default
    sourceExport: true,
    cloudBuild: true,
    productionExe: false,
    apiAccess: false,
    webhooks: false,
    buildAutomation: false,
    priorityQueue: true,
    privateProjects: true,
    launcherHosting: true,
    storageMb: 2048,
    maxBuildsPerDay: 30,
    purchasable: true,
    // Stripe Price objects are each pinned to a single currency -- supporting
    // checkout in more than one currency means configuring one real Stripe
    // Price per currency you actually want to charge in. If a currency's
    // entry here is null, checkout in that currency is refused with a clear
    // error rather than silently falling back to USD or faking success.
    stripePriceIds: { USD: process.env.STRIPE_PRICE_ID_PRO_USD || process.env.STRIPE_PRICE_ID_PRO || null, BDT: process.env.STRIPE_PRICE_ID_PRO_BDT || null }
  },
  dev: {
    id: 'dev',
    label: 'Dev',
    prices: { USD: 9.99, BDT: 1000 },
    maxActiveProjects: Infinity,
    sourceExport: true,
    cloudBuild: true,
    productionExe: true,
    apiAccess: true,
    webhooks: true,
    buildAutomation: true,
    priorityQueue: true,
    privateProjects: true,
    launcherHosting: true,
    storageMb: 10240,
    maxBuildsPerDay: 200,   // "unlimited... with infrastructure protection" -- this IS the protection
    purchasable: true,
    stripePriceIds: { USD: process.env.STRIPE_PRICE_ID_DEV_USD || process.env.STRIPE_PRICE_ID_DEV || null, BDT: process.env.STRIPE_PRICE_ID_DEV_BDT || null }
  },
  owner: {
    id: 'owner',
    label: 'Owner',
    prices: { USD: null, BDT: null }, // "∞/sec" in every currency -- never a real number, never charged
    maxActiveProjects: Infinity,
    sourceExport: true,
    cloudBuild: true,
    productionExe: true,
    apiAccess: true,
    webhooks: true,
    buildAutomation: true,
    priorityQueue: true,
    privateProjects: true,
    launcherHosting: true,
    storageMb: Infinity,
    maxBuildsPerDay: Infinity,
    purchasable: false,     // CANNOT be bought, ever, by anyone, at any price, in any currency
    stripePriceIds: { USD: null, BDT: null },
    isAdmin: true
  }
};

function getPlan(planId){
  return PLANS[planId] || PLANS.free;
}

function planAllows(planId, feature){
  const plan = getPlan(planId);
  return !!plan[feature];
}

// Formats a plan's price in the given currency, per the spec's exact rules:
// Owner is always "<symbol>\u221e/sec" (never a numeric amount, in ANY
// currency), and BDT amounts with no decimals get thousands separators
// (matching the example "৳1,000/month").
function formatPrice(planId, currency){
  const plan = getPlan(planId);
  const symbol = CURRENCY_SYMBOLS[currency] || currency;
  if(planId === 'owner') return symbol + '\u221e/sec';
  const amount = plan.prices[currency];
  if(amount == null) return 'N/A';
  if(amount === 0) return symbol + '0/month';
  const formatted = Number.isInteger(amount) ? amount.toLocaleString('en-US') : amount.toFixed(2);
  return symbol + formatted + '/month';
}

module.exports = { PLANS, getPlan, planAllows, formatPrice, CURRENCY_SYMBOLS, SUPPORTED_CURRENCIES };
