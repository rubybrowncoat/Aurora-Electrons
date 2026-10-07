-- all ship classes (for the player race) that do not have the current CrewDesignEfficiency tech
-- excludes:
--	obsolete
--	civilian shipping
--	"testing" in the name

SELECT
	sc.CrewDesignEfficiency
	,r.CrewDesignEfficiency
	,*
FROM
	FCT_ShipClass as sc
inner JOIN	vw_const as c on c.RaceID = sc.RaceID
inner join fct_race as r on r.RaceID = c.RaceID
WHERE
	sc.CrewDesignEfficiency > r.CrewDesignEfficiency
AND
	sc.Obsolete = 0
AND
	sc.ClassShippingLineID = 0
AND
	sc.ClassName not like '%testing%'
AND
	sc.OtherRaceClassID = 0				-- ignore classes captured from other races