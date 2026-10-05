SELECT
	grvpts
	,geopts
	,grvpts/geopts as ratio
FROM
(
	SELECT
		sum(
			sb.Radius/100.0 * 
				CASE 
					when sb.BodyTypeID in (4,5) then 1
					else 10 
				end 
		)as geopts
	from
		FCT_SystemBody as sb
	where sb.GameID > 115
) as geo
cross JOIN
(	
	select
		sum(s.JumpPointSurveyPoints * 30) as grvpts
	FROM
		FCT_System as s
	where s.GameID > 115
) as grav