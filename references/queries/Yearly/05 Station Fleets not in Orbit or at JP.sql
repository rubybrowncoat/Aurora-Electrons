select
	f.FleetName
	,wp.Name as Waypoint
	--,dsp.PopName as DSPName
	,*
FROM
	FCT_Fleet as f
inner JOIN
	vw_const as c
on
	c.RaceID = f.RaceID
left JOIN
	FCT_JumpPoint as jp
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
/*
left JOIN
	FCT_SystemBody as sb
on
	sb.Xcor = f.Xcor
AND
	sb.Ycor = f.Ycor
AND
	sb.SystemID = f.SystemID

	
left JOIN
	FCT_Population as dsp
on
	dsp.Xcor = f.Xcor
AND
	dsp.Ycor = f.Ycor
AND
	dsp.RaceID = c.RaceID
AND
	dsp.PopName like '% DSP%'
*/
WHERE
(
		f.FleetName like '\_%' Escape '\'
	or
		f.FleetName like '\.\.%' Escape '\'
	or
		f.FleetName like '\!%' Escape '\'
)
AND
	f.OrbitBodyID = 0
AND
	jp.WarpPointID is null

