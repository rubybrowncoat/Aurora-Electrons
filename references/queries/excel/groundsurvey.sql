--drop view vw_groundsurvey;
--create view vw_groundsurvey as 

with CTE_const as (	select (select max(GameID)from FCT_Game ) as GameID, (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as raceID)

SELECT
	upper(substr(sys.Name,1,3)) as Sys
	,upper(substr(sys.Name,1,3))
		|| '-' 
		|| 
		CASE 
			WHEN str.Component = 1 then 'A'
			WHEN str.Component = 2 then 'B'	
			WHEN str.Component = 3 then 'C'	
			WHEN str.Component = 4 then 'D'	
			WHEN str.Component = 5 then 'E'	
			WHEN str.Component = 6 then 'F'
			ELSE 'ZZZZZZZ'
		END	
		||
		CASE 
			WHEN sb.BodyTypeID = 1 THEN 'Ast' || sb.OrbitNumber
			WHEN sb.BodyTypeID = 14 THEN 'Com' || sb.OrbitNumber
			WHEN sb.ParentBodyType = 0 then (sb.PlanetNumber)			
			ELSE (sb.PlanetNumber || 'M' || sb.OrbitNumber)
		END 	
	as BasicName
	,pop.PopName
	,sb.GroundMineralSurvey as Quality
	,sb.Radius / 10 - ifnull(pop.GroundGeoSurvey,0) as GeoPointsRemaining
	,ifnull(form.UnitCount,0) as UnitCount
	,ifnull(form.GeoPointsPerDay*game.SurveySpeed/100,0) as GeoPointsPerDay
	,case when sb.GroundMineralSurvey = 0 then 0 else ifnull((sb.Radius / 10 - pop.GroundGeoSurvey)/form.GeoPointsPerDay/game.SurveySpeed*100,0) end as DaysRemaining
FROM
	FCT_SystemBodySurveys as sbs
inner join CTE_const as x on x.raceID = sbs.RaceID
inner join FCT_SystemBody as sb on sb.SystemBodyID = sbs.SystemBodyID
inner JOIN FCT_RaceSysSurvey as sys on sys.RaceID = x.raceID and sys.SystemID = sb.SystemID
left join FCT_Population as pop on pop.SystemBodyID = sb.SystemBodyID and pop.RaceID = x.raceID
inner join FCT_Game as game on game.GameID = x.GameID
--inner JOIN (select GameID, max(RaceID) as RaceID from FCT_Race where NPR = 0 group by GameID) as CurrentRace on	CurrentRace.RaceID = pop.RaceID and CurrentRace.GameID = game.GameID
left JOIN
	FCT_SystemBody as sb_parent
on
	sb_parent.SystemBodyID = sb.ParentBodyID
inner JOIN
	FCT_Star as str
on
	str.StarID = ifnull(sb_parent.ParentBodyID,sb.ParentBodyID)
or
(
	 --special case for Sol
	 --default bodies in Sol (i.e. not Minerva) have a ParentBodyID of 0
	 --since we know that Sol is a single-star system, we can just take the star that matches the SystemID
	ifnull(sb_parent.ParentBodyID,sb.ParentBodyID) = 0
	AND
	str.SystemID = sys.SystemID
)
left join 
(
	select
		form.PopulationID
		,sum(formelem.Units) as UnitCount
		,sum(class.GeoPointsPerDay*formelem.Units*ifnull(bon.BonusValue,1)) as GeoPointsPerDay
		
	from
		FCT_GroundUnitFormation as form 
	inner join 
		FCT_GroundUnitFormationElement as formelem 
	on 
		form.FormationID = formelem.FormationID
	inner JOIN
	(
		select
			class.GroundUnitClassID
			,case when class.ComponentA = 26 then 0.1 else 0 end 
			+ case when class.ComponentB = 26 then 0.1 else 0 end 
			+ case when class.ComponentC = 26 then 0.1 else 0 end 
			as GeoPointsPerDay
		from FCT_GroundUnitClass as class
		WHERE
		(
			class.ComponentA = 26 or
			class.ComponentB = 26 or
			class.ComponentC = 26
		)
	) as class on formelem.ClassID = class.GroundUnitClassID
	left JOIN
		FCT_Commander as cdr
	on
		cdr.CommandID = form.FormationID
	left JOIN
		FCT_CommanderBonuses as bon
	on
		bon.CommanderID = cdr.CommanderID
	AND
		bon.BonusID = 2
	group by
		form.PopulationID	
) as form
 on pop.PopulationID = form.PopulationID
 WHERE
	sb.GroundMineralSurvey > 0 --and pop.GroundGeoSurvey > 0
or
	ifnull (form.GeoPointsPerDay,0) > 0
order by
	sb.GroundMineralSurvey desc, pop.PopName