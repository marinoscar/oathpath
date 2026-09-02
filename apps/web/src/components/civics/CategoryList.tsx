/**
 * The top level of `/learn`: the official categories, grouped by section.
 *
 * Issue #121, epic #51.
 *
 * =============================================================================
 * GROUPED BY `section`, ORDERED BY `sortOrder`, NEITHER DECIDED HERE
 * =============================================================================
 *
 * `section` is presentation grouping copied verbatim from USCIS — free text on
 * purpose, not an enum, because this application does not branch on it. The
 * rows arrive already sorted by `sortOrder`, and that order is NOT alphabetical
 * in the official material (Government precedes History precedes Integrated
 * Civics). So this component preserves the server's order and never sorts: a
 * client-side `localeCompare` here would quietly renumber the exam.
 *
 * =============================================================================
 * EVERY ROW IS A REAL LINK
 * =============================================================================
 *
 * `ListItemButton component={RouterLink}` — so a category is focusable,
 * middle-clickable, openable in a new tab, and reachable with a keyboard, and
 * so the browser's own Back button returns from a question to the list the
 * learner came from. `/learn` keeps its view in the query string precisely so
 * this can be true without adding routes to the destination set #69 settled.
 */

import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Link as RouterLink } from 'react-router-dom';

import type { CivicsCategory } from '../../types';

export interface CategoryListProps {
  categories: CivicsCategory[];
  /** `'all'` or a category id → the `/learn` URL that opens it. */
  hrefForCategory: (categoryId: string) => string;
}

/** Groups without sorting: the first appearance of a section fixes its place. */
function groupBySection(
  categories: CivicsCategory[],
): { section: string; items: CivicsCategory[] }[] {
  const groups: { section: string; items: CivicsCategory[] }[] = [];
  for (const category of categories) {
    const existing = groups.find((group) => group.section === category.section);
    if (existing) existing.items.push(category);
    else groups.push({ section: category.section, items: [category] });
  }
  return groups;
}

export function CategoryList({ categories, hrefForCategory }: CategoryListProps) {
  const groups = groupBySection(categories);

  return (
    <Box>
      <List disablePadding sx={{ mb: 3 }}>
        <ListItem disablePadding>
          <ListItemButton
            component={RouterLink}
            to={hrefForCategory('all')}
            sx={{ borderRadius: 1 }}
          >
            <ListItemText
              primary="All questions"
              secondary="Every question in your test version, in order"
              slotProps={{ primary: { sx: { fontWeight: 600 } } }}
            />
            <ChevronRightIcon color="action" />
          </ListItemButton>
        </ListItem>
      </List>

      {groups.map((group) => (
        <Box key={group.section} sx={{ mb: 3 }}>
          {/* `h2` under the page's single `h1`, so the outline reads
              Learn → section → category → question. `variant` is decoupled
              from `component` because the heading LEVEL is semantics and the
              size is design; tying them together is how a page ends up with an
              `h4` between an `h1` and an `h3`. */}
          <Typography
            variant="overline"
            component="h2"
            color="text.secondary"
            sx={{ display: 'block', px: { xs: 0, sm: 1 } }}
          >
            {group.section}
          </Typography>

          <List disablePadding>
            {group.items.map((category) => (
              <ListItem key={category.id} disablePadding>
                <ListItemButton
                  component={RouterLink}
                  to={hrefForCategory(category.id)}
                  sx={{ borderRadius: 1 }}
                >
                  <ListItemText primary={category.name} />
                  <ChevronRightIcon color="action" />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Box>
      ))}
    </Box>
  );
}

export default CategoryList;
