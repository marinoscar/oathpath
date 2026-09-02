import { useState } from 'react';
import {
  IconButton,
  Avatar,
  Menu,
  MenuItem,
  Divider,
  ListItemIcon,
  ListItemText,
  Typography,
  Box,
} from '@mui/material';
import { Logout as LogoutIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { SETTINGS_DESTINATION } from '../../config/destinations';

export function UserMenu() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const open = Boolean(anchorEl);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleNavigate = (path: string) => {
    navigate(path);
    handleClose();
  };

  const handleLogout = async () => {
    handleClose();
    await logout();
  };

  if (!user) return null;

  // ONE NAVIGATION ROW: User Settings (#69, `docs/specs/journey-shell.md` §2.1).
  //
  // Its path, label and icon still come from the destination model rather than
  // being spelled out again here — this menu used to hardcode `/settings` and
  // `/admin/settings` and gate the latter on `system_settings:read` while the
  // sidebar gated the same page on the `admin` ROLE, and the two disagreed for
  // any Contributor granted that permission. There is still one answer; what
  // changed in #69 is that the menu names the destination it draws instead of
  // iterating whatever happens to be in `DESTINATIONS`.
  //
  // WHY IT IS NAMED HERE AT ALL: Settings moved OFF `DESTINATIONS` when the bar
  // became the four learner destinations. Left as a filter over that array this
  // menu would have silently lost its only row — and with it every path a user
  // has to their own profile, theme and tokens on a phone, where there is no
  // rail. So the row is explicit, and a test asserts it survives.
  //
  // NO PERMISSION GATE, and no `usePermissions` call: `SETTINGS_DESTINATION`
  // declares no permission because every authenticated user owns their own
  // settings, and none of the `/settings/*` routes is gated either.
  //
  // The four bar destinations are dropped for the same reason Home always was:
  // the rail (or the bottom bar below `sm`) is already showing every one of
  // them, and a menu row duplicating on-screen chrome is the bloat epic #51
  // removed. Console is dropped by MEMBERSHIP — it lives in
  // `RAIL_PINNED_DESTINATIONS` now, which only the rail reads. §2.2 of the spec
  // names that cost: an admin below `sm` reaches `/admin/settings` by URL or
  // bookmark, not from the nav chrome. Reachability is unchanged; only
  // discoverability on a narrow screen is.
  const menuDestinations = [SETTINGS_DESTINATION];

  const initials = user.displayName
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || user.email[0].toUpperCase();

  return (
    <>
      <IconButton
        onClick={handleOpen}
        size="small"
        aria-controls={open ? 'user-menu' : undefined}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : undefined}
      >
        <Avatar
          src={user.profileImageUrl || undefined}
          alt={user.displayName || user.email}
          sx={{ width: 32, height: 32, fontSize: '0.875rem' }}
        >
          {initials}
        </Avatar>
      </IconButton>

      <Menu
        id="user-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        onClick={handleClose}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        slotProps={{
          paper: { sx: { minWidth: 200, mt: 1 } },
        }}
      >
        {/* User Info Header */}
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" noWrap>
            {user.displayName || 'No name set'}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {user.email}
          </Typography>
        </Box>

        <Divider />

        {/* Navigation Items */}
        {menuDestinations.map((destination) => (
          <MenuItem
            key={destination.key}
            onClick={() => handleNavigate(destination.path)}
          >
            <ListItemIcon>
              <destination.Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{destination.label}</ListItemText>
          </MenuItem>
        ))}

        <Divider />

        {/* Logout */}
        <MenuItem onClick={handleLogout}>
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Logout</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}
