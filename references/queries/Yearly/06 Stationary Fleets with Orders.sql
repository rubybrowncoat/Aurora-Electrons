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
left JOIN
(
	select distinct FleetID from FCT_MoveOrders 
) as mo
on
	mo.FleetID = f.FleetID
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
(
		f.FleetName like '\_%' Escape '\'
	or
		f.FleetName like '\.\.%' Escape '\'
	or
		f.FleetName like '\!%' Escape '\'
)
AND
	mo.FleetID is not null

