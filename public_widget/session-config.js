/**
 * session-config.js — shared model for the Try for Tomorrow programme.
 *
 * The programme is 6 sessions. Each session is: watch a video, then make a
 * thematic pledge in answer to a question about what was watched.
 *
 * These are the BUILT-IN DEFAULTS. In production each session document lives at
 * `sessions/{n}` in Firestore and is admin-editable, so copy and video URLs can
 * change without a redeploy. Anything here is only the fallback when that
 * document is missing.
 *
 * PRIVACY: nothing in this module ever handles a student's real name. Students
 * are represented by a pseudonymous `student_ref`; the name behind it is
 * resolvable only via the WordPress roster. See TFT_STEERING_HANDOVER.md.
 */

export const SESSION_COUNT = 6;

/**
 * The 6 sessions — the real RTFxRFL programme content, from
 * docs/TFT - Learning Sessions.docx. Every session runs in the same four parts:
 *
 *   1. Watch & respond   a short film, paused at each question for team discussion
 *   2. Classroom task    apply the learning (cards, sorting, games)
 *   3. Physical task     reinforce it through a rugby activity
 *   4. Pledge to the planet   each student records one action for the week
 *
 * Fields:
 *   title, theme_note           the session name (+ optional sub-theme)
 *   summary                     one line on what the session is about
 *   outcomes[]                  learning outcomes
 *   film {title, questions[]}   the film and its pause-and-discuss questions
 *   classroom / physical        {title, blocks: [{heading?, items[]}]}
 *   citizen                     the "transfer learning" line for the pledge
 *   question, prompt            what the pledge widget asks (widget-facing)
 *   options[5]                  the five predefined pledges; the sixth is the
 *                               student's own suggestion (OWN_SUGGESTION_INDEX)
 *
 * The widget only needs question / prompt / options — in production those live
 * in `sessions/{n}` in Firestore (admin-editable). The lesson-plan fields are
 * facilitator content, which in production lives on the WordPress session pages.
 * A "Term: definition" item is shown with the term in bold.
 */
export const OWN_SUGGESTION_INDEX = 6;

/** The four parts, with the doc's one-line purpose for each (same every session). */
export const SESSION_PARTS = {
  film:      { label: 'Watch & respond', how: 'Watch the film together, pausing when asked to put the question on screen to the team and discuss the answer.' },
  classroom: { label: 'Classroom task',  how: 'Apply what was learnt in the film by completing the task.' },
  physical:  { label: 'Physical task',   how: 'Reinforce the learning through a physical activity that combines rugby training with the climate content.' },
  pledge:    { label: 'Pledge to the planet', how: 'Each student agrees one action to do this week and records it on the Pledge Maker. Small actions = big impact!' }
};

const PLEDGE_PROMPT = 'Small actions = big impact! Choose the pledge you’ll try this week.';

export const SESSIONS = [
  {
    n: 1, title: 'Greenhouse Gases / Climate Change', theme_note: '', video_url: '',
    summary: 'Learn about greenhouse gases – where they come from and the impact on the planet.',
    outcomes: [
      'To know that greenhouse gases in the atmosphere trap heat from the sun, making the planet’s temperature rise and causing climate change.',
      'To know where greenhouse gases come from.',
      'To name some greenhouse gases – carbon dioxide, methane and nitrous oxide.',
      'To suggest simple actions they can take to prevent climate change.'
    ],
    film: { title: 'Planet Stadium Live!', questions: [
      'What are greenhouse gases and where do they come from?',
      'What impact do greenhouse gases have on the planet?',
      'What happens when the planet heats up?',
      'What substitutions / interchanges would you make to save the planet?'
    ] },
    classroom: { title: 'Match Time', blocks: [
      { items: ['Use a timer to keep the team on task.', 'Discuss the answers and let them make any corrections.'] },
      { heading: 'In pairs or small groups – read the cards and match the words to the definitions.', items: [
        'Atmosphere: the envelope of gases that surrounds the Earth and makes life possible on the planet.',
        'Climate: the average weather and temperature of a place over a long period of time, usually 30 years.',
        'Climate Change: the long-term shift in temperatures and weather patterns in a region or globally. In the last 200 years human activity has increased greenhouse gas emissions, trapping heat, warming the Earth and causing climate change.',
        'Greenhouse Gases: the gases in the Earth’s atmosphere, such as carbon dioxide (CO₂), methane and nitrous oxide. They trap heat from the sun and keep the Earth warm, similar to how a greenhouse works.',
        'Methane: the greenhouse gas produced by cows and other animals when they burp or release gas.',
        'Carbon Dioxide: the greenhouse gas produced by burning fossil fuels like coal, oil and fuel in cars, factories and power stations.'
      ] }
    ] },
    physical: { title: 'Climate Gamechanger', blocks: [
      { heading: 'Beat the greenhouse gas and stop the planet from heating up!', items: [
        'Players stand in a circle representing the Earth / planet and side-pass the rugby ball around the circle.',
        'The coach or a player calls theme words – climate, Earth, atmosphere, methane, CO₂, nitrous oxide.',
        'Whoever holds the ball when a greenhouse gas is called passes to the next person, then runs around the circle back to their space before the ball gets back to it.',
        'Back before the ball: place a green beanbag in the centre – a calm planet.',
        'Ball gets there first: place a red beanbag in the centre – a planet getting hotter from greenhouse gases.'
      ] }
    ] },
    citizen: 'Transfer learning into the real world – become a responsible citizen.',
    question: 'After this session, what will you try to help with climate change?',
    prompt: PLEDGE_PROMPT,
    options: [
      'I will walk to or from school and/or Rugby training at least once this week.',
      'I will cycle to or from school and/or Rugby training at least once this week.',
      'I will try a vegan or vegetarian option for my school meal at least once this week.',
      'I will swap a meat based meal for one that has beans, lentils or chickpeas.',
      'I will talk to my family, coach or teacher about greenhouse gases and climate change.'
    ]
  },
  {
    n: 2, title: 'Food Waste', theme_note: '', video_url: '',
    summary: 'Learn about the impact of food waste on the planet and ways to reduce it.',
    outcomes: [
      'To know that food waste contributes to climate change.',
      'To name ways to prevent food waste.',
      'To understand date labels.'
    ],
    film: { title: 'Planet Earth Vs Food Waste', questions: [
      'What percentage of the food grown and produced worldwide is wasted?',
      'What could you do to prevent food from being wasted?',
      'Which date label is about food safety?',
      'What impact do greenhouse gases have on the planet?',
      'What is your second-half game plan for victory?'
    ] },
    classroom: { title: 'Prevent Food Waste: Unpack and Store', blocks: [
      { items: [
        'Use a timer to keep the team on task.',
        'Food delivery has arrived – place the food items in the correct storage location.',
        'Read the food labels and decide what order the snacks should be eaten in.',
        'Discuss choices and let them make any corrections.'
      ] }
    ] },
    physical: { title: 'Trash It or Try It!', blocks: [
      { heading: 'The coach shouts one of the following and players carry out the action:', items: [
        'EAT IT: run to the Try Zone.',
        'STORE IT: jog on the spot.',
        'WASTE IT: form a line of defence.'
      ] }
    ] },
    citizen: 'Transfer learning into the real world – become a responsible food citizen.',
    question: 'After this session, what will you try to reduce food waste?',
    prompt: PLEDGE_PROMPT,
    options: [
      'I will try a new food.',
      'I will eat up everything on my plate at least 3 times this week.',
      'I will help put the food shopping away making sure that it is stored in the right place.',
      'I will choose the food I eat by date rather than what I want.',
      'I will talk to my family / carer about food labels – ‘use by dates’ and ‘best before’ dates.'
    ]
  },
  {
    n: 3, title: 'Eat More Fruit & Veg', theme_note: 'Water in food production', video_url: '',
    summary: 'Learn why eating fruit and vegetables supports healthy people and a healthy planet.',
    outcomes: [
      'To know eating fruit and vegetables is better for people and the planet.',
      'To know water is needed in food production.',
      'To know less water is needed to produce apples than chocolate.'
    ],
    film: { title: 'Team Planet', questions: [
      'Do you think most of the fruit and vegetables we eat are grown in the UK or imported from other countries?',
      'How many litres of water do you think it takes to produce 1kg of chocolate?',
      'Could you substitute apples for chocolate and put the planet in front position?',
      'Which fruit is your best player?',
      'Which vegetable is your best attacker?'
    ] },
    classroom: { title: 'Higher / Lower Game: water in food production', blocks: [
      { items: [
        'Show and name the food item on the large card – the litres of water used to produce it are revealed by lifting the flap.',
        'Read the amount, then show the next card: will this food item be higher or lower?',
        'Encourage the team to shout “higher” or “lower”.',
        'Reveal to check the answer – were they correct? Were they surprised?'
      ] }
    ] },
    physical: { title: '5 A Day Challenge – Snack Attack!', blocks: [
      { items: [
        'For a team of 30, select 6 attackers (1 attacker for every 5 players).',
        'Everyone else is a vegetable snack. Each attacker tags 5 players, who become frozen veg.',
        'When all are frozen, the coach picks new attackers and shouts “DEFROST!” – all the frozen vegetables are free to be snacked again.'
      ] }
    ] },
    citizen: 'Transfer learning into the real world – become a responsible food citizen.',
    question: 'After this session, what will you try to eat more fruit and veg?',
    prompt: PLEDGE_PROMPT,
    options: [
      'I will try a new fruit or vegetable.',
      'I will eat 1 more fruit or vegetable on at least 2 days this week.',
      'I will swap a chocolate bar for a piece of fruit.',
      'I will eat the salad, vegetables or fruit option as part of my school meal at least once this week.',
      'I will tell my family or friends about a surprising fact I have learnt about water in food production.'
    ]
  },
  {
    n: 4, title: 'Eat Food That Keeps You Fuller and More Energised For Longer', theme_note: '', video_url: '',
    summary: 'Learn which foods keep us fuller and more energised for longer – and why these less processed foods are better for the planet too.',
    outcomes: [
      'To know foods that contain complex carbohydrates keep us fuller and more energised for longer.',
      'To name some foods that provide simple carbohydrates – chocolate, biscuits, white bread, mashed potato, pasta…',
      'To name some foods that provide complex carbohydrates – wholemeal bread, skin-on potatoes, brown rice, oats…',
      'To know less processed foods are better for people and the planet.'
    ],
    film: { title: 'Healthy Planet Vs Food Choices FC', questions: [
      'Can you name some simple carbohydrate foods? (Think white, filling foods and sugary ones too.)',
      'Can you name some complex carbohydrate foods? (Wholegrains and brown versions of a product.)',
      'Why do complex carbohydrate foods keep us feeling fuller and more energised for longer?',
      'Which simple-to-complex substitutions would you be willing to make?'
    ] },
    classroom: { title: 'Energise The Team or Sugar Lump Top Trumps', blocks: [
      { heading: 'Energise The Team', items: [
        'It’s time to energise the team – sort the foods into simple and complex carbohydrates.',
        'Discuss choices and let them make any corrections.',
        'Which foods would you swap to feel fuller and more energised for longer?'
      ] },
      { heading: 'Sugar Lump Top Trumps', items: [
        'Play in two teams or in pairs. Compare the sugar content of each food item – the card with the most sugar wins.',
        'Which foods are high in sugar? Were there any surprises?'
      ] }
    ] },
    physical: { title: 'Pass The Loaf!', blocks: [
      { items: [
        'One rugby ball is the loaf of brown bread.',
        'Two sets of 3 players: each set stands side by side in a line, at opposite ends of the area, facing each other.',
        'The set with the loaf passes it back and forth along the line while moving forward as fast as they can; the set without it moves as slowly as they can – staying side by side.',
        'When the sets meet, they hand the loaf over: the new holders are energised and speed up, the others slow down. Repeat.'
      ] }
    ] },
    citizen: 'Transfer learning into the real world – become a responsible food citizen.',
    question: 'After this session, what will you try to stay fuller and more energised for longer?',
    prompt: PLEDGE_PROMPT,
    options: [
      'I will swap white bread to brown bread.',
      'I will make water my go to drink instead of something sugary.',
      'I will swap a chocolate bar for a piece of fruit or vegetable snack.',
      'I will eat the skin on a baked potato.',
      'I will tell my family or carer about 3 foods which are good to eat to feel fuller and more energised for longer.'
    ]
  },
  {
    n: 5, title: 'Reduce, Reuse, Recycle', theme_note: '', video_url: '',
    summary: 'Learn about the impact of waste on the planet and the ways we can reduce, reuse and recycle.',
    outcomes: [
      'To know that some waste is buried in landfill and, as it decomposes, releases greenhouse gases that cause climate change.',
      'To know that some waste is burned, releasing greenhouse gases that cause climate change.',
      'To name ways to reduce, reuse and recycle waste.'
    ],
    film: { title: 'Team Planet Vs Team Waste', questions: [
      'Which do you think takes longest to decompose – a battery, a tin can or orange peel?',
      'What happens to waste?',
      'Why are these greenhouse gases bad for the planet?',
      'What could we do to reduce waste?',
      'What could we reuse?',
      'What could we recycle?'
    ] },
    classroom: { title: 'Sin Bin', blocks: [
      { heading: 'Acts of waste – which actions need an instant red card?', items: [
        'Look at and talk about the storyboard cards showing acts of waste, and decide which acts should get a red card.'
      ] }
    ] },
    physical: { title: 'Reduce, Reuse, Recycle', blocks: [
      { heading: 'Can the players make it to the recycling bank before the refuse collectors take them to landfill?', items: [
        '4 players are refuse collectors; everyone else is waste.',
        'The waste players dodge their way to the recycling bank.'
      ] }
    ] },
    citizen: 'Transfer learning into the real world – become a responsible citizen.',
    question: 'After this session, what will you try to reduce, reuse and recycle?',
    prompt: PLEDGE_PROMPT,
    options: [
      'I will reduce water waste by making sure taps are turned off when they are not in use.',
      'I will reduce electricity waste by turning off lights and electronics when they are not in use.',
      'I will reuse my water bottle.',
      'I will donate my kit or uniform that no longer fits me, to other people so it can be reused.',
      'I will recycle paper, plastic, glass and cans.'
    ]
  },
  {
    n: 6, title: 'Nurture Nature', theme_note: '', video_url: '',
    summary: 'Learn about the importance of protecting nature for healthy people and a healthy planet.',
    outcomes: [
      'To know that trees are natural greenhouse gas filters.',
      'To know that trees and plants are a vital part of the food chain.',
      'To know that deforestation is damaging to people and the planet.',
      'To name ways to defend wildlife and nurture nature.'
    ],
    film: { title: 'The Big Game!', questions: [
      'Why are trees Team Planet’s greatest defenders?',
      'What is a food chain?',
      'What is deforestation?',
      'How could you defend the planet?'
    ] },
    classroom: { title: 'Wildlife Defender', blocks: [
      { heading: 'How can you be a Wildlife Defender?', items: [
        'Discuss ways to be a wildlife defender, using the prompt card as a starting point:',
        'Plant flowers or trees for wildlife.',
        'Pick up litter on pitches, parks or playgrounds.'
      ] }
    ] },
    physical: { title: 'Nature’s Defenders', blocks: [
      { items: [
        'Some players form a line of defence.',
        'The other players are carbon dioxide – they try to get past the defence line. Anyone stopped joins the line.',
        'Points go to both sides depending on how successful they are.'
      ] }
    ] },
    citizen: 'Transfer learning into the real world – become a responsible citizen.',
    question: 'After this session, what will you try to nurture nature?',
    prompt: PLEDGE_PROMPT,
    options: [
      'I will grow some herbs.',
      'I will plant some wild flowers.',
      'I will plant a tree.',
      'I will do some litter picking.',
      'I will turn off electronics and lights when they are not in use.'
    ]
  }
];

/**
 * Media for each session — fill these in as RTF supply them; the portal shows
 * 'to be added' until then.
 *   physical_video  the physical task's demo video: a YouTube or Vimeo link, or an .mp4 URL
 *   worksheet       what the worksheet is (shown in the Document hub)
 * The worksheet PDFs themselves are versioned in worksheets/manifest.json (see doc-store.js).
 */
export const SESSION_MEDIA = {
  1: { physical_video: '', worksheet: 'Match Time word cards' },
  2: { physical_video: '', worksheet: 'Unpack and Store food cards' },
  3: { physical_video: '', worksheet: 'Higher / Lower water cards' },
  4: { physical_video: '', worksheet: 'Energise The Team and Sugar Lump Top Trumps cards' },
  5: { physical_video: '', worksheet: 'Sin Bin storyboard cards' },
  6: { physical_video: '', worksheet: 'Wildlife Defender prompt card' }
};

/** Look up a session definition by number (1-6). */
export function sessionByNumber(n) {
  return SESSIONS.find(s => s.n === Number(n)) || null;
}

/** True if `n` is a valid session number. Mirrors the isSession() rule. */
export function isValidSession(n) {
  return Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= SESSION_COUNT;
}

// ─────────────────────────────────────────────────────────────────────────────
// Student references
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expected group sizes. This is a SOFT cap: the facilitator is warned when they
 * pass it, never blocked. A 26-pupil class or a 5th group must not hit a wall
 * mid-session with students waiting.
 */
export const EXPECTED_GROUP_SIZE = 24;
export const EXPECTED_GROUPS     = 4;
export const SOFT_STUDENT_CAP    = EXPECTED_GROUP_SIZE * EXPECTED_GROUPS; // 96

/**
 * Mint a pseudonymous student reference.
 *
 * Generated on demand when a facilitator adds a student — not drawn from a
 * pre-allocated pool, so there is no ceiling to collide with. Must match the
 * isStudentRef() pattern in firestore.rules: ^p_[a-z0-9]{6,32}$
 *
 * This value is the ONLY student identifier that ever reaches Firebase.
 */
export function mintStudentRef() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return 'p_' + hex;
}

/** Mirrors the isStudentRef() rule so the UI can reject bad input early. */
export function isStudentRef(v) {
  return typeof v === 'string' && /^p_[a-z0-9]{6,32}$/.test(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cohorts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Student refs are scoped to a cohort (one intake). A provider re-running the
 * programme next year gets a fresh pool, so a given student_ref always means
 * exactly one human and progression reporting stays trustworthy.
 */
export function emptyCohort(label) {
  return { label: label || 'Default cohort', active: true, student_count: 0 };
}

/** Per-provider, per-session rollup. Answers "ever run? how many times?". */
export function emptySessionStats() {
  const stats = {};
  for (let n = 1; n <= SESSION_COUNT; n++) {
    stats['s' + n] = { runs: 0, pledges: 0, last_run_at: null };
  }
  return stats;
}

/** The flat cross-provider aggregate document (`public/session-totals`). */
export function emptySessionTotals() {
  const totals = { total_pledges: 0 };
  for (let n = 1; n <= SESSION_COUNT; n++) {
    totals['s' + n + '_runs']    = 0;
    totals['s' + n + '_pledges'] = 0;
  }
  return totals;
}
