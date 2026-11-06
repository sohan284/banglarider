import type { LandmarkSeed } from "../prepare-area";

/**
 * Landmarks for the Gulshan area.
 *
 * - Coordinates come from OSM at build time. `fallback` is used only when OSM
 *   has no match, and such entries are always flagged for verification.
 * - The Bangla name comes from OSM (name:bn, or a Bangla `name`); `bn` here is
 *   only used when OSM has none, and is flagged as a manual translation.
 * - Regexes were written against the OSM names present in November 2026
 *   (see .cache/overpass/gulshan-landmark-candidates.tsv after a run).
 */
const seeds: LandmarkSeed[] = [
  // Circles
  {
    id: "gulshan-1-circle",
    category: "circle",
    en: "Gulshan 1 Circle",
    bn: "গুলশান ১ গোলচত্বর",
    fallback: [90.41675, 23.78055],
    note: "OSM has no named Gulshan 1 Circle feature; point is the southern end of Gulshan Ave where its link roads meet",
  },
  { id: "gulshan-2-circle", category: "circle", en: "Gulshan 2 Circle", bn: "গুলশান ২ গোলচত্বর", name: /^gulshan 2 circle$/i, source: "road" },
  { id: "un-circle", category: "circle", en: "United Nations Circle", bn: "জাতিসংঘ গোলচত্বর", name: /^united nations? circle$/i, source: "road" },

  // Parks and lakes
  { id: "gulshan-lake-park", category: "park", en: "Gulshan Lake Park", bn: "গুলশান লেক পার্ক", name: /^(গুলশান লেক পার্ক|gulshan lake park)$/i, tags: { leisure: /park/ } },
  { id: "gulshan-park", category: "park", en: "Justice Shahabuddin Ahmed Park (Gulshan Park)", bn: "বিচারপতি সাহাবুদ্দিন আহমদ পার্ক", name: /^justice shahabuddin ahmed park/i, tags: { leisure: /park/ } },
  { id: "baridhara-park", category: "park", en: "Baridhara Park", bn: "বারিধারা পার্ক", name: /^baridhara park$/i, tags: { leisure: /park/ } },
  { id: "fazle-rabbi-park", category: "park", en: "Shahid Dr Fazle Rabbi Park", bn: "শহীদ ডাঃ ফজলে রাব্বী পার্ক", name: /fazle rabbi park/i },
  {
    id: "gulshan-lake",
    category: "lake",
    en: "Banani–Gulshan Lake",
    bn: "বনানী-গুলশান লেক",
    name: /^banani-gulshan lake$/i,
    tags: { natural: /water/ },
    note: "Point is the centre of a long, thin lake and may fall on the shore",
  },

  // Markets and shopping
  { id: "gulshan-1-market", category: "market", en: "Gulshan 1 DNCC Market", bn: "গুলশান ১ ডিএনসিসি মার্কেট", name: /গুলশান ১ ডিএনসিসি/ },
  { id: "gulshan-2-market", category: "market", en: "Gulshan 2 City Corporation Market", bn: "গুলশান ২ সিটি কর্পোরেশন মার্কেট", name: /city corporation market gulshan 2/i },
  { id: "pink-city", category: "market", en: "Pink City Shopping Centre", bn: "পিংক সিটি শপিং সেন্টার", name: /^pink city/i },
  { id: "navana-tower", category: "market", en: "Navana Tower Shopping Complex", bn: "নাভানা টাওয়ার শপিং কমপ্লেক্স", name: /navana tower/i },
  { id: "police-plaza", category: "market", en: "Police Plaza Concord", bn: "পুলিশ প্লাজা কনকর্ড", name: /police plaza/i },
  { id: "banani-super-market", category: "market", en: "Banani Super Market", bn: "বনানী সুপার মার্কেট", name: /^(বনানী সুপার মার্কেট|banani super market)$/i },

  // Mosques
  { id: "gulshan-central-mosque", category: "mosque", en: "Gulshan Central Mosque (Azad Mosque)", bn: "গুলশান কেন্দ্রীয় মসজিদ (আজাদ মসজিদ)", name: /gulshan central masjid|azad (mosque|masjid)/i, tags: { building: /mosque/ } },
  { id: "baridhara-mosque", category: "mosque", en: "Baridhara Mosque", bn: "বারিধারা মসজিদ", name: /^baridhara mosque$/i },
  { id: "banani-mosque", category: "mosque", en: "Banani Jame Mosque", bn: "বনানী জামে মসজিদ", name: /banani.*(central|jame).*(mosque|masjid)|বনানী.*মসজিদ/i },

  // Hospitals
  { id: "united-hospital", category: "hospital", en: "United Hospital", bn: "ইউনাইটেড হাসপাতাল", name: /^united hospital/i },
  { id: "shahabuddin-hospital", category: "hospital", en: "Shahabuddin Medical College Hospital", bn: "শাহাবুদ্দিন মেডিকেল কলেজ হাসপাতাল", name: /shahabuddin medical/i, tags: { building: /hospital/ } },

  // Major roads
  { id: "gulshan-avenue", category: "road", en: "Gulshan Avenue", bn: "গুলশান এভিনিউ", name: /^gulshan ave(nue)?$/i, source: "road" },
  { id: "kamal-ataturk-avenue", category: "road", en: "Kamal Ataturk Avenue", bn: "কামাল আতাতুর্ক এভিনিউ", name: /(kemal|kamal) ataturk/i, source: "road" },
  { id: "mir-shawkat-road", category: "road", en: "Bir Uttam Mir Shawkat Sarak (Gulshan–Tejgaon Link)", bn: "বীর উত্তম মীর শওকত সড়ক", name: /mir shawkat/i, source: "road" },
  { id: "gulshan-badda-link", category: "road", en: "Gulshan–Badda Link Road", bn: "গুলশান বাড্ডা লিংক রোড", name: /gulshan badda link/i, source: "road" },
  { id: "madani-avenue", category: "road", en: "Madani Avenue", bn: "মাদানী এভিনিউ", name: /^madani avenue$/i, source: "road" },

  // Other well-known places
  { id: "gulshan-club", category: "other", en: "Gulshan Club", bn: "গুলশান ক্লাব", name: /^gulshan club$/i },
  { id: "us-embassy", category: "embassy", en: "U.S. Embassy", bn: "মার্কিন দূতাবাস", name: /embassy of the united states/i, tags: { office: /diplomatic/ } },
  { id: "gulshan-police-station", category: "other", en: "Gulshan Police Station", bn: "গুলশান থানা", name: /^gulshan (police station|thana)$/i, tags: { amenity: /police/ } },
  { id: "westin", category: "other", en: "The Westin Dhaka", bn: "দ্য ওয়েস্টিন ঢাকা", name: /westin/i, tags: { tourism: /hotel/ } },
];

export default seeds;
