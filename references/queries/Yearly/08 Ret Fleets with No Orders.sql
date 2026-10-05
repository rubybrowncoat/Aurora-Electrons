select
	*
FROM
	FCT_Fleet as f
inner JOIN
	vw_const as c
on
	c.RaceID = f.RaceID	
left JOIN
(
	select distinct FleetID from FCT_MoveOrders 
) as mo
on
	mo.FleetID = f.FleetID
WHERE
(
		f.FleetName like 'r %'
	or
		f.FleetName like 'ret %'
	or
		(f.FleetName like '% ret%' and f.FleetName not like '%retug%')
	or
		f.FleetName like '__-__ %'  -- returning fleets are usually prefixed with YY-MM of their expected return date
)
AND
	f.FleetName not like 'XX%'
AND
	mo.FleetID is null

