// The onboarding sequence copy. DRAFT for Max's review: every sentence here is meant to be edited.
//
// This is the only file with wording in it. Timing is SEQUENCE_DAYS; the engine is sequence.ts.
// Tone: plain, confident, no hype, no emoji. A step returns blocks (paragraphs, headings, lists, one button);
// the engine renders them to text and to HTML in the brand layout and adds the unsubscribe footer.
//
// Facts to verify before the first real send (nothing here is shown to a lead; tests fail if the word VERIFY or a TODO
// reaches the copy):
//   - the current CMC requirements, and what each mailbox provider displays for a CMC versus a VMC;
//   - certificate cost and timing (it is bundled into the monthly BIMI price; the 12-month term must cover it);
//   - a trademark registration takes months.

import type { LetterBlock } from '../email/html-templates';
import type { CheckSummary } from '../email/report-formatter';
import type { ServicePrices } from './config';

/** Days after enrolment that each email goes out. The array length is the number of emails. */
export const SEQUENCE_DAYS = [1, 3, 6, 10, 14] as const;

export interface CopyContext {
  domain: string;
  /** The stored result of the check this person sent; null if it could not be read. */
  summary: Partial<CheckSummary> | null;
  bookingUrl: string | null;
  prices: ServicePrices;
}

export interface StepCopy {
  subject: string;
  blocks: LetterBlock[];
  /** The step cannot go out without a booking link. */
  needsBookingUrl?: boolean;
  /** Display name of the sender for this step (default: MAIL_FROM_NAME). */
  fromName?: string;
}

const SIGN_OFF = 'Inbox Angel';

/** One plain line in the free-check reply, next to the unsubscribe link. Must stay true to what the sequence does. */
export const DISCLOSURE = "You will also get a few short emails from us on fixing it, keeping it fixed, and getting your logo into the inbox (BIMI).";

// ── Step 1: what the result means, and the one fix that matters ─────────────

/** What the result means and the single most important fix, from the stored check. */
export function readResult(domain: string, s: Partial<CheckSummary> | null): { meaning: string; fix: string } {
  if (!s || !s.status) {
    return {
      meaning: `We checked the email you sent from ${domain}, but we could not read a complete result from it.`,
      fix: 'Send the check again from the address you use for your business email. If it still does not read cleanly, reply to this email and we will run it for you.',
    };
  }
  if (s.spfLookupFailed || s.dmarcLookupFailed) {
    return {
      meaning: `Part of the DNS lookup for ${domain} failed when we checked, so the result is incomplete rather than bad.`,
      fix: 'Send the check again in a few minutes. Nothing needs to change in your DNS until you have a complete result.',
    };
  }
  if (s.spfProblem || s.dmarcProblem) {
    return {
      meaning: `${domain} has an email record that exists but is broken: ${s.spfProblem ?? s.dmarcProblem}. Receiving servers treat a broken record as no record.`,
      fix: s.spfProblem
        ? 'Repair the SPF record so there is exactly one valid one. Two SPF records, or an invalid one, cancel each other out.'
        : 'Repair the DMARC record so there is exactly one valid one at _dmarc.' + domain + '.',
    };
  }
  if (!s.dmarcPolicy) {
    return {
      meaning: `${domain} has no DMARC record. If Shopify, Klaviyo or Google asked you to add one, this is the record they mean. Anyone can send email that claims to be from you, and receiving servers have no instruction to refuse it.`,
      fix: 'Publish a DMARC record at the monitoring level (p=none) with a reporting address. It blocks nothing, and it starts showing you every system that sends email as your domain. Every later step depends on that list.',
    };
  }
  if (!s.dmarcPass || (!s.spfPass && !s.dkimPass)) {
    return {
      meaning: `The email you sent did not pass DMARC for ${domain}. The system that sent it is not properly authenticated as you, so under an enforced policy this email would have been rejected or sent to spam.`,
      fix: 'Authenticate the service that sent this email: add it to your SPF record, or better, turn on DKIM signing with your own domain in that service. Then send the check again.',
    };
  }
  if (s.dmarcPolicy === 'none') {
    return {
      meaning: `This email passed, and ${domain} has DMARC, but the policy is p=none: it reports and blocks nothing. Receiving servers are not told to refuse mail that fakes your domain.`,
      fix: 'Read the DMARC reports, authenticate every legitimate sender they reveal, then move to p=quarantine. Doing it in that order is what keeps your own invoices and newsletters out of spam.',
    };
  }
  if (s.dmarcPolicy === 'quarantine') {
    return {
      meaning: `${domain} is enforcing DMARC at quarantine: mail that fails goes to spam. That is real protection, and it is one step short of the strongest setting.`,
      fix: 'Move to p=reject once the reports show no legitimate mail failing. BIMI, your logo in the inbox, accepts quarantine or reject, but most brands finish at reject.',
    };
  }
  return {
    meaning: `${domain} is enforcing DMARC at p=reject, and this email passed. That is the strongest setting and the hard part is done.`,
    fix: 'Keep it working: a new tool that sends as you will fail silently unless someone sets it up. The next step up is BIMI, which puts your logo next to your messages (day 6).',
  };
}

// ── The sequence ─────────────────────────────────────────────────────────────

export function stepCopy(index: number, c: CopyContext): StepCopy {
  const d = c.domain;
  switch (index) {
    case 0: {
      const { meaning, fix } = readResult(d, c.summary);
      return {
        subject: `What your email check for ${d} means`,
        blocks: [
          `You sent us an email from ${d} to check how it is protected. Here is what the result means, without the acronyms. If Shopify, Klaviyo or Google told you to add DMARC, this is what they are asking for, and the question behind it is: am I done?`,
          { heading: 'What we found' },
          meaning,
          { heading: 'The one thing to do first' },
          fix,
          'Over the next two weeks we will send a few short emails on where this leads: enforcement, keeping it fixed, and then BIMI. If you would rather have it done for you, with a written confirmation at the end that you are done, reply to this email.',
          SIGN_OFF,
        ],
      };
    }
    case 1:
      return {
        subject: 'p=none, quarantine, reject: what enforcement means',
        blocks: [
          'DMARC has three policies. They decide what a receiving server does with mail that claims to be from your domain but fails authentication.',
          { list: [
            'p=none: do nothing, just report. This is where almost everyone starts. It is monitoring only; nothing is blocked.',
            'p=quarantine: deliver failing mail to spam.',
            'p=reject: refuse failing mail at the door.',
          ] },
          { heading: 'What breaks if you do it carelessly' },
          'Your own mail also fails DMARC when a system that sends for you is not authenticated: the CRM, the billing tool, the helpdesk, the newsletter service, an old server nobody remembers. Switch to reject too early and invoices bounce and customer replies vanish, usually without any error that reaches you.',
          { heading: 'How we do it safely' },
          { list: [
            'We start at p=none and read the reports until we have the full list of who sends as you.',
            'We authenticate each legitimate sender, one at a time.',
            'We move to quarantine on a small percentage, watch the reports, and widen it.',
            'We go to reject only when the reports show nothing legitimate failing, and we can roll back at each step.',
          ] },
          { heading: 'Why it has to stay fixed' },
          'Once you are at reject, a new tool that sends as you (a newsletter service, a CRM, a helpdesk, invoicing) fails silently: its mail just does not arrive, and nothing tells you. Someone has to set each new sender up before it goes live, and rotate keys when they expire. That is why a fixed setup needs looking after, and it is what we call Keep it fixed.',
          'It is not complicated, but it takes patience and attention to the reports. That is the part we do for you.',
          SIGN_OFF,
        ],
      };
    case 2:
      return {
        subject: `Your logo in the inbox: BIMI for ${d}`,
        blocks: [
          "BIMI (Brand Indicators for Message Identification) lets your logo appear next to your messages in the inbox, in mailbox apps that support it, including Gmail and Apple Mail. It is a visible signal to your customers that the message is really yours. It is only available to domains that have fixed the problem from the first two emails, and whether a logo is shown is always the mailbox provider's decision.",
          { heading: 'What it needs' },
          { list: [
            'DMARC enforcement: p=quarantine or p=reject, applied to all of your mail. This is the part that takes the time.',
            'Your logo as an SVG in the specific SVG Tiny PS profile, square, served over HTTPS. Most logo files need to be converted; an ordinary SVG export is rejected.',
            'A certificate for the logo: a VMC (Verified Mark Certificate), which requires a registered trademark, or a CMC (Common Mark Certificate), which does not but asks for proof that you have used the logo publicly for some time. Gmail can show a logo with either; Apple Mail needs a VMC, so a CMC alone will not get you there.',
            'A BIMI DNS record that points to the logo and the certificate.',
          ] },
          { heading: 'What it costs and how long it takes' },
          'We include the certificate in a monthly plan, so there is no upfront certificate fee. We buy it from an authorised certificate authority and renew it for you. The term is 12 months, and leaving earlier means paying the remaining certificate cost. A trademark registration, if you need one for a VMC, takes months and is outside our work. Once enforcement is in place, the logo conversion, the certificate and the DNS record take days.',
          'So the order matters: enforcement first, then BIMI. If you want your logo showing, the work starts with step one.',
          SIGN_OFF,
        ],
      };
    case 3: {
      const p = c.prices;
      const priced = (label: string, price?: string) => (price ? `${label} Price: ${price}.` : label);
      const anyPrice = Object.keys(p).length > 0;
      return {
        subject: 'How we work',
        blocks: [
          'We do this as a done-for-you service, with three offers. Start with the first; the other two are optional.',
          { list: [
            priced('Fix it. A screen-share session where we inventory every system that sends as you and fix SPF and DKIM. Then we move DMARC from none to quarantine to reject over about 90 days, watching the reports the whole time, which is included. It ends with a written confirmation that you are done.', p.fix),
            priced('Keep it fixed. Offered at day 90, and easy to decline. We stay silent while everything is fine and send a short quarterly note saying so. We alert you only when something needs action, together with the fix. New sending tools are set up, keys are rotated, and there is a human to call.', p.keepFixed),
            priced("BIMI, your logo in the inbox. Requires Fix it first. We convert the logo to the required format, buy and renew the certificate (included in the monthly price, no upfront certificate fee), publish the record and verify it. It includes Keep it fixed. 12-month term; leaving earlier pays the remaining certificate cost. Whether a logo is shown is always the mailbox provider's decision.", p.bimi),
          ] },
          anyPrice ? 'Fix it is quoted after a short look at your setup; the monthly plans are priced per domain or per brand.' : 'We quote each job after a short look at your setup, so there is no price list to misread.',
          'Not sure which you need? Take a free 30-minute call and we will look at your domain together. Or reply to this email and say which offer you want.',
          ...(c.bookingUrl ? [{ cta: { label: 'Book the free call', url: c.bookingUrl } }] : []),
          SIGN_OFF,
        ],
      };
    }
    default:
      return {
        subject: `Want me to look at ${d} with you?`,
        needsBookingUrl: true,
        fromName: 'Max at Inbox Angel',
        blocks: [
          `A short note from me. You checked ${d} two weeks ago, and I wanted to ask directly: would it help if I looked at it with you?`,
          'It is a conversation of about half an hour. I will tell you what I see, what I would fix first, and what it would take. If it turns out you can handle it yourselves, I will say so.',
          { cta: { label: 'Pick a time', url: c.bookingUrl ?? '' } },
          'If now is not the time, no problem. This is the last email in this series.',
          'Max at Inbox Angel',
        ],
      };
  }
}
