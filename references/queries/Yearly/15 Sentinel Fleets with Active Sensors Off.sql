SELECT
	*
FROM
	vw_const as c
inner JOIN
	FCT_Fleet as f
on
	f.RaceID = c.RaceID
inner JOIN
	FCT_Ship as s
on
	s.FleetID = f.FleetID
WHERE
	f.FleetName like '%\_\_\_sent%' Escape '\'
AND
	s.ActiveSensorsOn = 0