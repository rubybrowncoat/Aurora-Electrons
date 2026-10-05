select
	*
FROM
	vw_const as c
inner join fct_fleet as f on f.RaceID = c.RaceID
left join vw_Fleets_FuelFairies as v on v.FleetID = f.FleetID
WHERE
	f.FleetName like 'fuel fairy%'
AND
	v.FleetName is null
-- check the fleetname has the correct class name(s)
