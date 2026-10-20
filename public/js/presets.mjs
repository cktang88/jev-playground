// Starter content per task. Decide presets swap the state only (the questions are
// general enough to apply to any of them); extract presets bring their own fields,
// because fields only make sense against a matching document.

const TICKET = [
  'Ticket #48210 - "Charged twice for the Pro plan"',
  "Customer: Dana Whitfield (dana@acme-ops.com), Pro plan since March 2024, 14 seats, 6 active.",
  "Opened 2 days ago after the annual renewal on 2026-09-14 posted two charges of $240 each.",
  "Dana says the duplicate charge drained the team card and wants a refund plus an explanation.",
  "Support (Priya) replied once, asked for a bank statement screenshot, then went quiet for 30 hours.",
  'Sentiment: frustrated but polite. Dana wrote: "I have been happy with the product, I just need this fixed."',
  "Account notes: no prior billing disputes, NPS 8, renewal date 2027-09-14.",
].join("\n");

export const DECIDE_PRESETS = [
  { key: "ticket", label: "Support ticket", state: TICKET },
  {
    key: "review",
    label: "Product review",
    state: [
      "Soundcore Q30 headphones - 4/5 stars (verified purchase, 2026-08-02)",
      "Battery easily lasts 40 hours, exactly as advertised. Noise cancelling is fine on a plane, weak in a busy cafe.",
      "The companion app is clunky and forgets my EQ preset about once a week.",
      "Comfort is great for long flights, no ear pressure after 6 hours of wear.",
      "For $79 these are a steal, but if active noise cancelling is your top priority, spend more.",
    ].join("\n"),
  },
  {
    key: "chat",
    label: "Chat log",
    state: [
      "[10:02] customer: hi, my export keeps failing at 80%",
      "[10:03] agent: sorry about that - which plan are you on?",
      "[10:03] customer: team plan, exporting about 40k rows",
      "[10:05] agent: 40k rows can hit the 30 second timeout on the shared workers",
      "[10:06] customer: can I raise it?",
      "[10:07] agent: not yet, but I can move you to a dedicated worker this week",
      "[10:09] customer: that works, thanks. any ETA?",
      "[10:10] agent: I will email you by Thursday",
    ].join("\n"),
  },
  {
    key: "json",
    label: "JSON record",
    json: true,
    state: JSON.stringify(
      {
        account_id: "acc_9f31",
        plan: "growth",
        seats: 42,
        seats_active_30d: 31,
        mrr_usd: 1890,
        tenure_months: 19,
        support_tickets_90d: 7,
        last_login_days_ago: 12,
        nps: 6,
        renewal_date: "2026-11-02",
        notes: "Champion left the company in July; no replacement identified.",
      },
      null,
      2,
    ),
  },
];

export const DECIDE_DEFAULT_ITEMS = [
  {
    id: "churn_risk",
    type: "noul",
    instructions: "Is this customer likely to churn or downgrade in the next 90 days?",
    criteria: {
      true: "Signals of churn: cancellation language, unresolved blockers, falling usage, no internal champion.",
      false: "Signals of retention: healthy usage, issues being resolved, positive sentiment, clear value.",
    },
  },
  {
    id: "intent",
    type: "choice",
    instructions: "What is the primary intent of this message?",
    criteria: {
      billing: "Money, invoices, refunds or plan charges",
      technical_issue: "Something is broken or not working",
      cancellation: "Wants to leave or downgrade",
      feature_request: "Asking for something new",
    },
  },
  {
    id: "urgency",
    type: "score",
    instructions: "How urgent is this for the customer?",
    criteria: ["Not urgent", "Slightly urgent", "Urgent", "Critical - needs action today"],
  },
];

const INVOICE =
  "Invoice INV-2291 from Northwind Supply, issued 2026-09-02, net 30. 4 pallets at $250.00 each, shipping $80.00. Contact: Dana Ruiz, Priya Shah.";

const CLAIM = [
  "From: Marcus Bell <marcus.bell@example.com>",
  "Subject: Damaged standing desk - order 88-41207",
  "",
  "Hi, my standing desk (order 88-41207) arrived on October 3rd. I paid $649.00.",
  "When I unboxed it the left leg was bent and the control panel has a cracked screen.",
  "The desk still goes up and down but wobbles badly at full height.",
  "Can you help? I'd rather not ship the whole thing back if a replacement leg works.",
  "Thanks, Marcus",
].join("\n");

const SERIES = [
  "Daily support tickets opened, last 3 weeks.",
  "date,weekday,tickets",
  "2026-09-28,Mon,412", "2026-09-29,Tue,398", "2026-09-30,Wed,405", "2026-10-01,Thu,431",
  "2026-10-02,Fri,377", "2026-10-03,Sat,201", "2026-10-04,Sun,188",
  "2026-10-05,Mon,429", "2026-10-06,Tue,410", "2026-10-07,Wed,402", "2026-10-08,Thu,446",
  "2026-10-09,Fri,391", "2026-10-10,Sat,215", "2026-10-11,Sun,193",
  "2026-10-12,Mon,438", "2026-10-13,Tue,421", "2026-10-14,Wed,417", "2026-10-15,Thu,455",
  "2026-10-16,Fri,402", "2026-10-17,Sat,222", "2026-10-18,Sun,199",
  "Forecast from: 2026-10-19 (Mon)",
].join("\n");

export const EXTRACT_PRESETS = [
  {
    key: "invoice",
    label: "Invoice",
    state: INVOICE,
    items: [
      { id: "invoice_number", type: "text" },
      { id: "due_date", type: "date", instructions: "Issue date plus the net payment days" },
      { id: "total", type: "number", instructions: "Amount due including shipping", params: { decimals: "2", unit: "USD" } },
      { id: "contacts", type: "list", params: { items: "text" } },
      { id: "po_number", type: "text", instructions: "Purchase order number" },
      { id: "days_to_pay", type: "estimate", instructions: "Days after issue until this invoice is paid", params: { min: "0", max: "120", step: "1" } },
    ],
  },
  {
    key: "claim",
    label: "Damage claim email",
    state: CLAIM,
    options: { reference_date: "2026-10-20" },
    items: [
      { id: "customer_name", type: "text" },
      { id: "order_id", type: "text", instructions: "Order number" },
      { id: "amount_paid", type: "number", params: { decimals: "2", unit: "USD" } },
      { id: "days_since_delivery", type: "duration", instructions: "Time from delivery until the reference date", params: { unit: "days", integer: true } },
      { id: "damage", type: "list", instructions: "Each distinct damage reported", params: { items: "text" } },
      { id: "tracking_number", type: "text", instructions: "Shipment tracking number" },
      { id: "repair_cost", type: "estimate", instructions: "Cost to repair the damage described", params: { min: "10", max: "2000", scale: "log", step: "1", unit: "USD" } },
    ],
  },
  {
    key: "series",
    label: "Forecast a series",
    state: SERIES,
    items: [
      { id: "tickets_next_week", type: "forecast", instructions: "Tickets opened on each of the next 7 days", params: { horizon: "7", interval: "day", min: "50", max: "1500", scale: "log" } },
      { id: "busiest_weekday", type: "text", instructions: "Weekday with the most tickets" },
      { id: "avg_weekend", type: "number", instructions: "Average tickets on a weekend day", params: { decimals: "0" } },
    ],
  },
];
