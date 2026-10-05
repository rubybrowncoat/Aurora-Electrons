select
	f.FleetName
	,bn.BodyName
	,jp.JPName
	,wp.Name as Waypoint
	,mo.Description as MoveOrderDescription
	,*
FROM
	vw_const as c
inner JOIN
	FCT_Fleet as f
on
	f.RaceID = c.RaceID	
inner JOIN
(
	select distinct FleetID from FCT_MoveOrders where MoveActionID not in
	(
		64		-- Stabilise Jump Point
		,217	-- Stabilise Lagrange Point
		--,3		-- Join Fleet									(overhauling fleets often have final join orders)		
		--,157	-- Land on Specified Mothership (No Assign)		(overhauling fleets sometimes have final orders to land in a hangar)		
		--,112	-- Send Message
		--,1		-- Standard Transit
	)
) as mox
on
	mox.FleetID = f.FleetID
inner JOIN
	FCT_MoveOrders as mo
on
	mo.FleetID = f.FleetID
left JOIN
	vw_BodyName as bn
on
	bn.SystemBodyID = f.OrbitBodyID
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
WHERE
	f.Speed = 1
AND
	f.FleetName not like '%TIMER%'
order by
	f.FleetName, mo.MoveOrder