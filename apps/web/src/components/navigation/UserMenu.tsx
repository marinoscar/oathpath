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
import { usePermissions } from '../../hooks/usePermissions';
import {
  CONSOLE_DESTINATION,
  SETTINGS_DESTINATION,
  isDestinationVisible,
} from '../../config/destinations';

export function UserMenu() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const { user, logout } = useAuth();
  const { hasPermission } = usePermissions();
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

  // TWO NAVIGATION ROWS: User Settings, then System Settings for an admin
  // (#69 for the first, issue #232 for the second; `docs/specs/journey-shell.md`
  // §2.1-§2.2).
  //
  // Both rows take their path, label and icon from the destination model rather
  // than spelling them out again here. This menu used to hardcode `/settings`
  // and `/admin/settings` and gate the latter on `system_settings:read` while
  // the sidebar gated the same page on the `admin` ROLE, and the two disagreed
  // for any Contributor granted that permission. There is still ONE answer to
  // both questions; what changed in #69 is that the menu NAMES the destinations
  // it draws instead of iterating whatever happens to be in `DESTINATIONS`.
  //
  // (a) USER SETTINGS CARRIES NO PERMISSION. `SETTINGS_DESTINATION` declares
  //     none because every authenticated user owns their own settings, and none
  //     of the `/settings/*` routes is gated either — so this row is
  //     unconditional.
  //
  // (b) SYSTEM SETTINGS IS GATED THROUGH `isDestinationVisible`, never by an
  //     inline `destination.permission` test and never by `isAdmin` or any other
  //     role check. That function is the only thing that reads
  //     `CONSOLE_DESTINATION`'s `anyPermission` — `system_settings:read` OR
  //     `users:read`, the strings `system-settings.controller.ts` and
  //     `users.controller.ts` actually enforce — and an inline
  //     `!d.permission || hasPermission(d.permission)` here would silently show
  //     the row to everyone, because `CONSOLE_DESTINATION` sets no `permission`
  //     at all. A user who cannot reach the surface gets no row.
  //
  // (c) `CONSOLE_DESTINATION` STAYS OUT OF `DESTINATIONS` AND OUT OF
  //     `BottomNav`. The four-bar-destination ceiling (`DESTINATIONS.length <=
  //     4`) is untouched by this menu: it names the two destinations it draws
  //     rather than iterating an array, which is exactly what lets it add a
  //     Console row without spending a bar slot on one.
  //
  // (d) THE FOUR BAR DESTINATIONS ARE STILL DROPPED HERE, for the same reason
  //     Home always was: the rail (or the bottom bar below `sm`) is already
  //     drawing every one of them, and a menu row duplicating on-screen chrome
  //     is the bloat epic #51 removed.
  //
  // (e) THIS REVERSES THE DISCOVERABILITY COST `docs/specs/journey-shell.md`
  //     §2.2 accepted (issue #232). Console lives in
  //     `RAIL_PINNED_DESTINATIONS`, which only the rail reads — and the rail is
  //     unmounted below `sm`, so an admin on a phone had no path to
  //     `/admin/settings` from the chrome at all, and none from the user menu at
  //     any width. This menu is the ONE settings surface that exists at every
  //     width, which is why the row belongs here rather than in a fifth bar
  //     slot.
  const menuDestinations = [
    SETTINGS_DESTINATION,
    ...(isDestinationVisible(CONSOLE_DESTINATION, hasPermission) ? [CONSOLE_DESTINATION] : []),
  ];

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
