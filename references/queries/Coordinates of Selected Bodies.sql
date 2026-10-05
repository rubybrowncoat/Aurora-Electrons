SELECT
	v.BodyName, sb.Xcor/1000/1000/1000, sb.Ycor/1000/1000/1000, sb.Bearing, sb.OrbitalDistance
FROM
	vw_BodyName as v
inner JOIN
	FCT_SystemBody as sb
on
	sb.SystemBodyID = v.SystemBodyID
WHERE
	v.BodyName in ('ABB-A5','ABC-ACom8','ABC-ACom6','ABD-ACom12','CAB-ACom2','CAB-ACom3','CAB-ACom4','CUA-ACom8')
