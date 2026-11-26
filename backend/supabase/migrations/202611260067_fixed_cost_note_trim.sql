-- The console's MiniMax card already shows the plan's points (used / total), so the seeded note
-- "含每月 100,000 点" on the fixed bill (0058) only repeats it. Clear it; a note an operator wrote is kept.
update companion_private.fixed_costs set note = null where note = '含每月 100,000 点';
