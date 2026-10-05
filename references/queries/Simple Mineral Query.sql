SELECT
	sys.Name as System
	,
	CASE
		WHEN sb.BodyTypeID = 1 AND sb.OrbitNumber = 0 then pop.PopName -- DSPs
		ELSE
			sys.Name
				|| '-' 
				|| 
				CASE 
					WHEN str.Component = 1 then 'A'
					WHEN str.Component = 2 then 'B'	
					WHEN str.Component = 3 then 'C'	
					WHEN str.Component = 4 then 'D'	
					WHEN str.Component = 5 then 'E'	
					WHEN str.Component = 6 then 'F'	
					ELSE 'XXXXXXXXXXXXX'
				END	
				||
				CASE 
					WHEN sb.BodyTypeID = 1 THEN 'Ast' || sb.OrbitNumber
					WHEN sb.BodyTypeID = 14 THEN 'Com' || sb.OrbitNumber
					WHEN sb.ParentBodyType = 0 then (sb.PlanetNumber)			
					ELSE (sb.PlanetNumber || 'M' || sb.OrbitNumber)
				END
	END	as SimpleName
	,pop.PopName as Colony
	,ifnull(sb_mins.Duranium		/1000 ,0) 	as	Duranium
	,ifnull(sb_mins.Neutronium		/1000 ,0) 	as	Neutronium
	,ifnull(sb_mins.Corbomite		/1000 ,0) 	as	Corbomite
	,ifnull(sb_mins.Tritanium		/1000 ,0) 	as	Tritanium
	,ifnull(sb_mins.Boronide		/1000 ,0) 	as	Boronide
	,ifnull(sb_mins.Mercassium		/1000 ,0) 	as	Mercassium
	,ifnull(sb_mins.Vendarite		/1000 ,0) 	as	Vendarite
	,ifnull(sb_mins.Sorium			/1000 ,0) 	as	Sorium
	,ifnull(sb_mins.Uridium			/1000 ,0) 	as	Uridium
	,ifnull(sb_mins.Corundium		/1000 ,0) 	as	Corundium
	,ifnull(sb_mins.Gallicite		/1000 ,0) 	as	Gallicite
	
	,ifnull(sb_mins.DuraniumAcc	,0)			as	DuraniumAcc
	,ifnull(sb_mins.NeutroniumAcc	,0) 	as	NeutroniumAcc
	,ifnull(sb_mins.CorbomiteAcc	,0) 	as	CorbomiteAcc
	,ifnull(sb_mins.TritaniumAcc	,0) 	as	TritaniumAcc
	,ifnull(sb_mins.BoronideAcc	,0) 		as	BoronideAcc
	,ifnull(sb_mins.MercassiumAcc	,0) 	as	MercassiumAcc
	,ifnull(sb_mins.VendariteAcc	,0) 	as	VendariteAcc
	,ifnull(sb_mins.SoriumAcc		,0) 	as	SoriumAcc
	,ifnull(sb_mins.UridiumAcc		,0) 	as	UridiumAcc
	,ifnull(sb_mins.CorundiumAcc	,0) 	as	CorundiumAcc
	,ifnull(sb_mins.GalliciteAcc	,0) 	as	GalliciteAcc
FROM
(
	select max(RaceID) as RaceID from fct_race where NPR = 0
) as Race
inner JOIN
	FCT_RaceSysSurvey as sys
on 
	sys.RaceID = Race.RaceID
inner JOIN
	FCT_SystemBody as sb
on
	sb.SystemID  = sys.SystemID
left JOIN
	FCT_Population as pop
on
	pop.SystemBodyID = sb.SystemBodyID
AND
	pop.RaceID = Race.RaceID
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
inner JOIN
	FCT_SystemBodySurveys as surv
on
	surv.RaceID = Race.RaceID
AND
	surv.SystemBodyID = sb.SystemBodyID
left JOIN
(
	select 
		md.SystemBodyID
		,sum(case when md.MaterialID = 1 then md.Amount else 0 end) as Duranium
		,sum(case when md.MaterialID = 2 then md.Amount else 0 end) as Neutronium
		,sum(case when md.MaterialID = 3 then md.Amount else 0 end) as Corbomite
		,sum(case when md.MaterialID = 4 then md.Amount else 0 end) as Tritanium
		,sum(case when md.MaterialID = 5 then md.Amount else 0 end) as Boronide
		,sum(case when md.MaterialID = 6 then md.Amount else 0 end) as Mercassium
		,sum(case when md.MaterialID = 7 then md.Amount else 0 end) as Vendarite
		,sum(case when md.MaterialID = 8 then md.Amount else 0 end) as Sorium
		,sum(case when md.MaterialID = 9 then md.Amount else 0 end) as Uridium
		,sum(case when md.MaterialID = 10 then md.Amount else 0 end) as Corundium
		,sum(case when md.MaterialID = 11 then md.Amount else 0 end) as Gallicite

		,sum(case when md.MaterialID = 1 then md.Accessibility else 0 end) as DuraniumAcc
		,sum(case when md.MaterialID = 2 then md.Accessibility else 0 end) as NeutroniumAcc
		,sum(case when md.MaterialID = 3 then md.Accessibility else 0 end) as CorbomiteAcc
		,sum(case when md.MaterialID = 4 then md.Accessibility else 0 end) as TritaniumAcc
		,sum(case when md.MaterialID = 5 then md.Accessibility else 0 end) as BoronideAcc
		,sum(case when md.MaterialID = 6 then md.Accessibility else 0 end) as MercassiumAcc
		,sum(case when md.MaterialID = 7 then md.Accessibility else 0 end) as VendariteAcc
		,sum(case when md.MaterialID = 8 then md.Accessibility else 0 end) as SoriumAcc
		,sum(case when md.MaterialID = 9 then md.Accessibility else 0 end) as UridiumAcc
		,sum(case when md.MaterialID = 10 then md.Accessibility else 0 end) as CorundiumAcc
		,sum(case when md.MaterialID = 11 then md.Accessibility else 0 end) as GalliciteAcc		
	from 
		FCT_MineralDeposit as md 
	group by 
		md.SystemBodyID
) as sb_mins
on
	sb_mins.SystemBodyID = surv.SystemBodyID

order by sys.DiscoveredTime, sys.SystemID, sb.SystemBodyID