/**
 * The per-user settings information architecture — the same registry shape as
 * `adminSections.tsx`, for the `/settings` surface.
 *
 * Issue #91, epic #90. `/settings` is today one page stacking three cards
 * (Theme, Profile, Personal Access Tokens). Epic #90 splits it into routed
 * destinations behind the same searchable hub the admin console gets (#96), so
 * it needs the same thing the console needs: ONE declaration read by the hub,
 * the AppBar's title resolver, and anything else that later wants to draw the
 * surface.
 *
 * This file deliberately declares only DATA. The `SettingsCardDef` /
 * `SettingsSectionDef` types and both helpers
 * (`visibleSettingsSections`, `settingsPageTitle`) are imported from
 * `adminSections.tsx` and re-used verbatim — which is precisely why those
 * helpers take `sections`, `hubPath` and `hubTitle` as parameters instead of
 * closing over the admin constants. Two copies of the permission gate is the
 * drift the registry exists to prevent, and copying it here to serve a second
 * surface would reintroduce it on day one.
 */

import PersonIcon from '@mui/icons-material/Person';
import FlagIcon from '@mui/icons-material/Flag';
import PaletteIcon from '@mui/icons-material/Palette';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import PsychologyIcon from '@mui/icons-material/Psychology';
import NotificationsIcon from '@mui/icons-material/Notifications';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import type { SettingsSectionDef } from './adminSections';

/**
 * The user settings sections, in hub order.
 *
 * NO CARD DECLARES A `permission`, and that is the correct model rather than
 * an omission: every authenticated user owns their own settings, and the API
 * grants `user_settings:read` / `user_settings:write` to all three roles
 * (Admin, Contributor, Viewer). Adding a gate here would be inventing an
 * authorization rule the API does not enforce — the opposite of what this
 * registry is for. `visibleSettingsSections` is still the function the hub
 * calls, so search filtering and empty-section collapsing behave identically
 * to the admin surface; the permission half of the gate simply passes
 * everything through.
 *
 * Access Tokens sits under its own `Security` group rather than under
 * `Account` because a PAT is a long-lived credential: grouping it with display
 * name and theme would put "create a bearer token that outlives your session"
 * one row below "pick a colour scheme".
 */
export const USER_SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'Account',
    cards: [
      {
        // Issue #77, epic #50. The ongoing home for the six answers
        // `/setup/journey` (#72) collects once — every one of which changes
        // over a naturalization case: an interview is scheduled or moved, a
        // learner moves state, a daily goal turns out to be too ambitious, the
        // 65/20 accommodation starts applying after a birthday.
        //
        // A REGISTRY CARD PLUS A ROUTE, never a tab on an existing settings
        // page (CLAUDE.md's Settings UI Pattern, rule 2): this is its own
        // destination — a reachability question — and it is not a second view
        // of anything else's content.
        //
        // Under `Account` rather than `Security`: `Security` holds long-lived
        // CREDENTIALS, for the reason that group's own note gives, and this
        // page holds no credential at all. It is the learner's own answers
        // about their situation — the same kind of per-account preference
        // Profile, Appearance and Notifications are — so it belongs where they
        // are. It leads the group because it is the one card here a learner
        // has a real reason to come back to: an interview date moves.
        //
        // NO `permission`, like every card in this file.
        // `PUT /api/journey/profile` is `@Auth()` with no permissions and
        // resolves the caller from the token, so there is no string to mirror
        // — and inventing one would gate a learner out of their own plan.
        title: 'Your plan',
        description:
          'Your filing date, interview date, state, and how much you want to study each day.',
        Icon: FlagIcon,
        path: '/settings/journey',
      },
      {
        title: 'Profile',
        description: 'Your display name and profile image, and the email you signed in with.',
        Icon: PersonIcon,
        path: '/settings/profile',
      },
      {
        title: 'Appearance',
        description: 'Choose a light, dark, or system-matched theme for this account.',
        Icon: PaletteIcon,
        path: '/settings/appearance',
      },
      {
        // Issue #288, epic #280. Every voice preference in that epic — the
        // premium opt-in `QuestionAudio` used to take as a hard-coded `false`,
        // which voice, how fast, whether a spoken answer submits itself —
        // needed somewhere to live, and this is it.
        //
        // A REGISTRY CARD PLUS A ROUTE, never a tab on an existing settings
        // page (CLAUDE.md's Settings UI Pattern, rule 2): this is a
        // reachability question — its own destination — not a second view of
        // Appearance's content. It sits NEXT TO Appearance because the two are
        // the same kind of answer (how this account looks; how it sounds) and
        // a learner looking for one will look where the other is.
        //
        // NO `permission`, like every card in this file.
        // `PATCH /api/user-settings` grants `user_settings:write` to all three
        // roles, and `GET /api/ai/speech/voices` is `@Auth()` with no
        // permissions — there is no "may choose a voice" privilege in this
        // product's authorization model to mirror, and inventing one would
        // leave a Viewer, the default role, unable to slow down the voice
        // reading them their questions.
        title: 'Voice',
        description:
          'How questions are read to you, and what happens when you answer out loud.',
        Icon: RecordVoiceOverIcon,
        path: '/settings/voice',
      },
      {
        // Issue #322, epic #305 (E14 "The Coach's personality"). Where a
        // learner chooses how the product talks to them about their answers.
        //
        // A REGISTRY CARD PLUS A ROUTE, never a tab on Voice (CLAUDE.md's
        // Settings UI Pattern, rules 1 and 2). The two are different axes and
        // a destination gate is about REACHABILITY where a tab gate is about
        // CONTENT: `voice` governs how spoken practice sounds, `coach`
        // governs how an answer is framed — in text as much as in speech —
        // and a learner who never presses play still has a coach. Folding it
        // into Voice would hide the whole coach configuration behind a
        // heading whose other controls do nothing for them.
        //
        // NEXT TO Voice because a learner looking for "how this thing talks
        // to me" will look where "how this thing sounds" is.
        //
        // NO `permission`, like every card in this file.
        // `PATCH /api/user-settings` grants `user_settings:write` to all three
        // roles and `GET /api/ai/coach/personas` is `@Auth()` with no
        // permissions — there is no "may choose a coach" privilege in this
        // product's authorization model, and inventing one would leave a
        // Viewer, the default role, unable to change how the app speaks to
        // them.
        title: 'Coach',
        description:
          'How your coach talks to you about your answers, and whether it says anything beyond the verdict.',
        Icon: PsychologyIcon,
        path: '/settings/coach',
      },
      {
        // Issue #126, epic #109. NO `permission`, like every card here: the
        // page edits the caller's OWN preferences through
        // `PATCH /api/user-settings`, which the API grants to all three roles,
        // and the registry it renders (`GET /api/notifications/events`) is
        // `@Auth()` with no permissions for exactly that reason — gating this
        // card would leave a Viewer unable to say how they are contacted.
        //
        // Under `Account` rather than `Security`, even though one of the events
        // it lists is a security alert: the card is about how this account is
        // contacted, not about credentials. `Security` holds long-lived
        // credentials (see the group's own note below).
        title: 'Notifications',
        description:
          'Choose which events notify you, and whether they arrive by email or in your browser.',
        Icon: NotificationsIcon,
        path: '/settings/notifications',
      },
    ],
  },
  {
    label: 'Security',
    cards: [
      {
        // Issue #42, epic #25. Under `Security` beside Access Tokens, for the
        // reason this group's own note gives: an OpenAI key is a long-lived
        // credential, and grouping it with display name and theme would put
        // "the credential everything you do runs on" one row below "pick a
        // colour scheme".
        //
        // NO `permission`, like every card here. Every authenticated user owns
        // their own credentials, and `AiUserKeyController` is `@Auth()` with no
        // permissions for exactly that reason — gating this card would invent
        // an authorization rule the API does not enforce, and since a keyless
        // user is hard-blocked (#39) it would leave the gated role unable to
        // use the app at all.
        title: 'AI key',
        description:
          'Your own OpenAI key, which everything in OathPath runs on, and what it has been used for.',
        Icon: AutoAwesomeIcon,
        path: '/settings/ai',
      },
      {
        title: 'Access Tokens',
        description: 'Create and revoke personal access tokens for API and CLI access.',
        Icon: VpnKeyIcon,
        path: '/settings/tokens',
      },
    ],
  },
  {
    // Issue #270. Its OWN group, after `Security`, not a third member of it:
    // `Security` is reserved for long-lived CREDENTIALS (see that group's own
    // note above) — an OpenAI key and a personal access token are things you
    // HOLD. A data reset is not a credential at all, so filing it under
    // `Security` would stretch that group's meaning to cover an unrelated
    // kind of danger (irreversible data loss) rather than share its actual
    // one. A dedicated `Danger zone` group names what the card is honestly
    // about and gives a second one (were this ever to grow, e.g. an eventual
    // account-deletion card) a home that does not first require redefining
    // what `Security` means.
    label: 'Danger zone',
    cards: [
      {
        // A REGISTRY CARD PLUS A ROUTE, never a tab on an existing settings
        // page (CLAUDE.md's Settings UI Pattern, rule 2): this is a
        // reachability question — its own destination — not a second view of
        // Profile's or AI key's content. It also cannot be folded into
        // either: Profile edits who you are, AI key edits a credential, and
        // this ERASES what both of those pages describe. Three different
        // questions, three different destinations.
        //
        // NO `permission`, like every card in this file.
        // `POST /api/account/reset` and `GET /api/account/data-summary` are
        // both `@Auth()` with no permissions and resolve the account from
        // `@CurrentUser('id')` only (see `account.controller.ts`'s own
        // header) — every authenticated user owns their own data, and
        // erasing it is a choice only its owner can make about themselves.
        // There is no permission string on the API to mirror here, and
        // inventing one would gate a user out of a choice that is
        // structurally theirs alone: not even an admin can reset another
        // user's data through this controller.
        title: 'Reset your data',
        description: 'Erase your progress and start over. This cannot be undone.',
        Icon: WarningAmberIcon,
        path: '/settings/reset',
      },
    ],
  },
];

/**
 * The user settings hub — the one `/settings` route that owns no card.
 *
 * `USER_HUB_TITLE` is intentionally the same string as `ADMIN_HUB_TITLE`
 * ('Settings'): the two surfaces are never on screen at once, the path
 * disambiguates them for the title resolver, and calling this one "My
 * Settings" in the AppBar would be the only place in the app that names it
 * that way.
 */
export const USER_HUB_PATH = '/settings';
export const USER_HUB_TITLE = 'Settings';
