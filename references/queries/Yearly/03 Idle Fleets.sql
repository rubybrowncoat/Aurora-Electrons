select
	f.FleetName
	,bn.BodyName
	,jp.JPName
	,wp.Name as Waypoint
	,*
FROM
	FCT_Fleet as f
inner JOIN
	vw_const as c
on
	c.RaceID = f.RaceID	
inner JOIN
(
	select distinct FleetID from FCT_Ship where MaintenanceState <> 2
) as s
on
	s.FleetID = f.FleetID
left JOIN
(
	select distinct FleetID from FCT_MoveOrders 
) as mo
on
	mo.FleetID = f.FleetID
left JOIN
(
	select distinct FleetID from FCT_Ship where MaintenanceState = 2
) as ov
on
	ov.FleetID = f.FleetID
left JOIN
	vw_jumppoints as jp
on
	jp.Xcor = f.Xcor
AND
	jp.Ycor = f.Ycor
left JOIN
	FCT_Waypoint as wp
on
	wp.Xcor = f.Xcor
AND
	wp.Ycor = f.Ycor
AND
	wp.RaceID = c.RaceID
left JOIN
	vw_BodyName as bn
on
	bn.SystemBodyID = f.OrbitBodyID
WHERE
	f.ShippingLine = 0
AND
(
		f.FleetName not like '  ..%'	--	''
	and
		f.FleetName not like ' ..%'	--	''
	and
		f.FleetName not like '..%'	--	''
	and
		f.FleetName not like '%\_\_\_%' Escape '\'
	--and		f.FleetName not like '%\-\-%' Escape '\'
	and f.FleetName not like '%zzzzzz'
	and
		f.FleetName not like '!%' Escape '\'
	and
		f.FleetName not like '%XX TIMER%'
	and
		f.FleetName not like '.sw %'
	and
		f.FleetName not like '.c %'
	and
		f.FleetName not like 'cj %'
	and
		f.FleetName not like 'dst %'
	and
		f.FleetName not like 'zip %'
	and
		f.FleetName not like 'salv %'
	AND
		f.FleetName not like 'fuel fairy%spin'
	AND
		f.FleetName not like 'fuel fairy%misc%'
	AND
		f.FleetName not like '_todo%'
	and ((f.FleetName not like '% ov' and f.FleetName not like '% ov|%' and f.FleetName not like '% ov %') or ov.FleetID is null)	-- ignore "ov" fleets unless there is no overhauling ship in the fleet
	and (f.FleetName not like '\-\-|%' Escape '\' or bn.BodyName is null)	-- ignore "--|" fleets unless not in orbit of a body
)
AND
	mo.FleetID is null
order by
	bn.BodyName
	,jp.JPName
	,wp.Name
	,f.FleetName

