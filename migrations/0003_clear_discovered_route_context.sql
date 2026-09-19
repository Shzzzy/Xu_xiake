-- Origin, waypoints, and destination are user-controlled route fragments.
-- Keep the compatibility column, but never retain that context in shared rows.
update discovered_places
set route_context = '[]'::jsonb
where route_context <> '[]'::jsonb;
